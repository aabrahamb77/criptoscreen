'use strict';
/**
 * bot/strategies.js
 * Conjunto de estrategias con GATING POR RÉGIMEN. Cada una devuelve una señal
 * en el mismo formato {symbol, side, strategy, price, atr, stop, takeProfit,
 * score, reason, components} o null.
 *
 * Estrategias:
 *   - lxr            (reversión)      : Liquidation Exhaustion Reversal
 *   - vwapReclaim    (reversión+conf) : recupera VWAP tras una cascada
 *   - fundingFade    (reversión)      : fade de funding extremo cerca del settlement
 *   - breakoutOiCvd  (continuación)   : ruptura confirmada por OI y CVD
 *   - fakeoutFade    (reversión)      : ruptura falsa (OI cae / CVD diverge) -> fade
 *   - momentumDelta  (continuación)   : momentum confirmado por delta (CVD)
 *
 * Gating:
 *   trend    -> breakoutOiCvd, momentumDelta
 *   volatile -> lxr, vwapReclaim, fundingFade
 *   range    -> fakeoutFade, fundingFade, lxr
 */
const C = require('./config');
const m = require('./metrics');
const ind = require('./indicators');
const lxr = require('./strategy'); // evaluate() existente

const ALLOWED = {
  trend: ['breakoutOiCvd', 'momentumDelta'],
  volatile: ['lxr', 'vwapReclaim', 'fundingFade'],
  range: ['fakeoutFade', 'fundingFade', 'lxr'],
};

function levels(side, price, atrVal, ref, cfg) {
  let stop, tp, risk;
  if (side === 'long') { stop = ref - cfg.STOP_ATR_MULT * atrVal; risk = price - stop; tp = price + cfg.TP_R_MULTIPLE * risk; }
  else { stop = ref + cfg.STOP_ATR_MULT * atrVal; risk = stop - price; tp = price - cfg.TP_R_MULTIPLE * risk; }
  return { stop, takeProfit: tp, risk };
}

function nearFundingSettlement(nowMs, windowMin = 30) {
  const d = new Date(nowMs);
  const h = d.getUTCHours(), min = d.getUTCMinutes();
  const slots = [0, 8, 16];
  let best = Infinity;
  for (const s of slots) {
    let diff = ((s - h) * 60 - min);
    diff = ((diff % (24 * 60)) + 24 * 60) % (24 * 60); // minutos hasta el próximo slot
    best = Math.min(best, diff);
  }
  return best <= windowMin;
}

// --- VWAP reclaim post-cascada -------------------------------------------
function vwapReclaim(ctx, atrVal) {
  const { klines, trades, liqs, nowMs } = ctx;
  // baseline acotado por la cobertura real del WS (evita z-score inflado tras reconexión)
  const baseline = Math.max(1, Math.min(C.LIQ_BASELINE_SEC, ctx.liqBaselineSec ?? C.LIQ_BASELINE_SEC));
  const liq = m.liquidationPressure(liqs, C.LIQ_WINDOW_SEC * 3, baseline, nowMs);
  if (liq.direction === 'none' || liq.z < C.LIQ_Z_THRESHOLD * 0.8) return null;
  const closes = klines.map(k => k.close);
  const price = closes[closes.length - 1], prev = closes[closes.length - 2];
  // VWAP anclado ~20 velas atrás (inicio aproximado de la cascada)
  const anchor = Math.max(0, klines.length - 20);
  const vw = ind.anchoredVWAP(klines, anchor);
  const cvdShort = m.cvdFromTrades(trades, nowMs - C.CVD_WINDOW_SEC * 1000);

  let side = null;
  if (liq.direction === 'long_liq' && prev < vw && price >= vw && cvdShort > 0) side = 'long';
  if (liq.direction === 'short_liq' && prev > vw && price <= vw && cvdShort < 0) side = 'short';
  if (!side) return null;

  const ref = side === 'long' ? Math.min(...klines.slice(-3).map(k => k.low)) : Math.max(...klines.slice(-3).map(k => k.high));
  const { stop, takeProfit, risk } = levels(side, price, atrVal, ref, C);
  if (risk <= 0) return null;
  const score = Math.round((Math.min(liq.z / 4, 1) * 40 + 35 + 25) * 10) / 10; // cascada + reclaim + flujo
  return {
    symbol: ctx.symbol, side, strategy: 'vwapReclaim', price, atr: atrVal, stop, takeProfit, score,
    reason: `Reclaim VWAP tras ${liq.direction} z=${liq.z.toFixed(1)} | VWAP=${vw.toFixed(6)} | CVD ${cvdShort.toFixed(0)}`,
    components: { liqZ: +liq.z.toFixed(2), vwap: +vw.toFixed(8), cvdShort: +cvdShort.toFixed(2) },
  };
}

// --- Funding-reset fade ---------------------------------------------------
function fundingFade(ctx, atrVal) {
  if (!nearFundingSettlement(ctx.nowMs)) return null;
  const fz = m.fundingZscore(ctx.currentFunding, ctx.fundingHist || []);
  if (Math.abs(fz) < C.FUNDING_Z_CONFLUENCE + 0.5) return null;
  const closes = ctx.klines.map(k => k.close);
  const price = closes[closes.length - 1];
  const moveAtr = m.atrNormalize(Math.abs(price - closes[closes.length - 4]), atrVal);
  if (moveAtr < 1.0) return null;
  // funding muy positivo (largos pagando) -> fade SHORT ; muy negativo -> LONG
  const side = fz > 0 ? 'short' : 'long';
  const ref = side === 'long' ? Math.min(...ctx.klines.slice(-3).map(k => k.low)) : Math.max(...ctx.klines.slice(-3).map(k => k.high));
  const { stop, takeProfit, risk } = levels(side, price, atrVal, ref, C);
  if (risk <= 0) return null;
  const score = Math.round((Math.min(Math.abs(fz) / 4, 1) * 50 + Math.min(moveAtr / 3, 1) * 30 + 20) * 10) / 10;
  return {
    symbol: ctx.symbol, side, strategy: 'fundingFade', price, atr: atrVal, stop, takeProfit, score,
    reason: `Funding extremo z=${fz.toFixed(1)} cerca de settlement | move=${moveAtr.toFixed(1)}ATR`,
    components: { fundingZ: +fz.toFixed(2), moveAtr: +moveAtr.toFixed(2) },
  };
}

// --- Ruptura confirmada / falsa por OI + CVD ------------------------------
function breakoutCore(ctx, atrVal, wantFakeout) {
  const { klines, trades, oiSeries, nowMs } = ctx;
  if (klines.length < 25 || oiSeries.length < 3) return null;
  const closes = klines.map(k => k.close);
  const price = closes[closes.length - 1];
  const win = klines.slice(-21, -1); // rango previo (excluye vela actual)
  const rangeHigh = Math.max(...win.map(k => k.high));
  const rangeLow = Math.min(...win.map(k => k.low));
  const oiChg = m.pctChange(oiSeries[oiSeries.length - 1].oi, oiSeries[oiSeries.length - 3].oi);
  const cvdShort = m.cvdFromTrades(trades, nowMs - C.CVD_WINDOW_SEC * 1000);

  const brokeUp = price > rangeHigh;
  const brokeDown = price < rangeLow;
  if (!brokeUp && !brokeDown) return null;

  const oiUp = oiChg > 0;
  const flowUp = cvdShort > 0;
  // confirmación: OI sube y CVD acompaña la dirección de la ruptura
  const confirmedUp = brokeUp && oiUp && flowUp;
  const confirmedDown = brokeDown && oiUp && !flowUp;
  const confirmed = confirmedUp || confirmedDown;

  if (!wantFakeout && confirmed) {
    const side = brokeUp ? 'long' : 'short';
    const { stop, takeProfit, risk } = levels(side, price, atrVal, price, C);
    if (risk <= 0) return null;
    const score = Math.round((35 + Math.min(Math.abs(oiChg) / 2, 1) * 30 + 35) * 10) / 10;
    return { symbol: ctx.symbol, side, strategy: 'breakoutOiCvd', price, atr: atrVal, stop, takeProfit, score,
      reason: `Ruptura ${side === 'long' ? '↑' : '↓'} confirmada | OI ${oiChg.toFixed(2)}% | CVD ${cvdShort.toFixed(0)}`,
      components: { oiChgPct: +oiChg.toFixed(2), cvdShort: +cvdShort.toFixed(2), rangeHigh, rangeLow } };
  }
  if (wantFakeout && !confirmed) {
    // ruptura sin respaldo -> fade en contra. Score DINÁMICO según la
    // evidencia real de fakeout (antes era fijo 70 y siempre pasaba el filtro):
    //  - OI cayendo (posiciones cerrándose, no abriéndose) ........ hasta 30
    //  - CVD oponiéndose a la dirección de la ruptura ............. hasta 30
    //  - mecha de rechazo en la vela actual (vs ATR) ............... hasta 15
    //  - base por ruptura no confirmada ............................ 25
    const side = brokeUp ? 'short' : 'long';
    const oiFade = Math.min(Math.max(-oiChg, 0) / 1.0, 1);                    // OI cayendo hasta -1%
    const cvdOpp = brokeUp ? cvdShort < 0 : cvdShort > 0;
    const cvdMag = Math.min(Math.abs(cvdShort) / 500, 1);
    const lastK = klines[klines.length - 1];
    const rej = brokeUp ? lastK.high - price : price - lastK.low;             // mecha de rechazo
    const rejAtr = Math.min(m.atrNormalize(Math.max(rej, 0), atrVal), 1);
    const score = Math.round((25 + oiFade * 30 + (cvdOpp ? 20 + cvdMag * 10 : 0) + rejAtr * 15) * 10) / 10;

    const ref = brokeUp ? Math.max(price, rangeHigh) : Math.min(price, rangeLow);
    const { stop, takeProfit, risk } = levels(side, price, atrVal, ref, C);
    if (risk <= 0) return null;
    return { symbol: ctx.symbol, side, strategy: 'fakeoutFade', price, atr: atrVal, stop, takeProfit, score,
      reason: `Ruptura falsa (OI ${oiChg.toFixed(2)}% / CVD ${cvdShort.toFixed(0)} / rechazo ${rejAtr.toFixed(1)}ATR) -> fade ${side}`,
      components: { oiChgPct: +oiChg.toFixed(2), cvdShort: +cvdShort.toFixed(2), rejAtr: +rejAtr.toFixed(2), oiFade: +oiFade.toFixed(2) } };
  }
  return null;
}
const breakoutOiCvd = (ctx, atr) => breakoutCore(ctx, atr, false);
const fakeoutFade = (ctx, atr) => breakoutCore(ctx, atr, true);

// --- Momentum confirmado por delta ---------------------------------------
function momentumDelta(ctx, atrVal) {
  const { klines, trades, oiSeries, nowMs } = ctx;
  const closes = klines.map(k => k.close);
  const price = closes[closes.length - 1];
  const move = price - closes[closes.length - 4];
  const moveAtr = m.atrNormalize(Math.abs(move), atrVal);
  if (moveAtr < 1.0) return null;
  const cvdShort = m.cvdFromTrades(trades, nowMs - C.CVD_WINDOW_SEC * 1000);
  const oiChg = oiSeries.length >= 3 ? m.pctChange(oiSeries[oiSeries.length - 1].oi, oiSeries[oiSeries.length - 3].oi) : 0;
  const up = move > 0;
  const confirmed = up ? (cvdShort > 0 && oiChg > 0) : (cvdShort < 0 && oiChg > 0);
  if (!confirmed) return null;
  const side = up ? 'long' : 'short';
  const { stop, takeProfit, risk } = levels(side, price, atrVal, price, C);
  if (risk <= 0) return null;
  const score = Math.round((Math.min(moveAtr / 3, 1) * 40 + 30 + Math.min(Math.abs(oiChg) / 2, 1) * 30) * 10) / 10;
  return { symbol: ctx.symbol, side, strategy: 'momentumDelta', price, atr: atrVal, stop, takeProfit, score,
    reason: `Momentum ${side} ${moveAtr.toFixed(1)}ATR confirmado por CVD ${cvdShort.toFixed(0)} | OI ${oiChg.toFixed(2)}%`,
    components: { moveAtr: +moveAtr.toFixed(2), cvdShort: +cvdShort.toFixed(2), oiChgPct: +oiChg.toFixed(2) } };
}

function lxrWrap(ctx) {
  return lxr.evaluate({
    symbol: ctx.symbol, klines: ctx.klines, oiSeries: ctx.oiSeries,
    fundingHist: ctx.fundingHist, currentFunding: ctx.currentFunding,
    trades: ctx.trades, liqs: ctx.liqs, nowMs: ctx.nowMs,
    liqBaselineSec: ctx.liqBaselineSec,
  });
}

const REGISTRY = {
  lxr: (ctx, atr) => { const s = lxrWrap(ctx); return s ? Object.assign(s, { strategy: 'lxr' }) : null; },
  vwapReclaim, fundingFade, breakoutOiCvd, fakeoutFade, momentumDelta,
};

/**
 * Evalúa todas las estrategias permitidas por el régimen del símbolo.
 * Devuelve { regime, best, candidates } (best = mayor score >= MIN_SIGNAL_SCORE).
 */
function evaluateAll(ctx) {
  const highs = ctx.klines.map(k => k.high), lows = ctx.klines.map(k => k.low), closes = ctx.klines.map(k => k.close);
  if (closes.length < C.ATR_PERIOD + 5) return { regime: null, best: null, candidates: [] };
  const atrVal = m.atr(highs, lows, closes, C.ATR_PERIOD);
  const reg = ind.regime(highs, lows, closes);
  ctx.regime = reg;

  const allowed = ALLOWED[reg.regime] || [];
  const candidates = [];
  for (const name of allowed) {
    try {
      const sig = REGISTRY[name](ctx, atrVal);
      if (sig && sig.score >= C.MIN_SIGNAL_SCORE) { sig.regime = reg.regime; candidates.push(sig); }
    } catch (_) { /* estrategia robusta: si falla una, seguimos */ }
  }
  candidates.sort((a, b) => b.score - a.score);
  return { regime: reg, best: candidates[0] || null, candidates };
}

module.exports = { evaluateAll, ALLOWED, REGISTRY, nearFundingSettlement };
