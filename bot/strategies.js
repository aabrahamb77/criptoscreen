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
  trend: ['health'],
  volatile: ['health'],
  range: ['health'],
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

// --- 💎 Estrategia de Salud (healthScore >= 60) ---------------------------
function health(ctx, atrVal) {
  const { klines, oiSeries, currentFunding, trades, liqs, nowMs, ticker } = ctx;
  const closes = klines.map(k => k.close);
  const price = closes[closes.length - 1];

  // 1) Calcular variaciones porcentuales de precio en diferentes timeframes
  // En base a klines de 1m (KLINE_LIMIT = 300)
  const p5m = closes.length >= 6 ? ((price - closes[closes.length - 6]) / closes[closes.length - 6]) * 100 : 0;
  const p15m = closes.length >= 16 ? ((price - closes[closes.length - 16]) / closes[closes.length - 16]) * 100 : 0;
  const p1h = closes.length >= 61 ? ((price - closes[closes.length - 61]) / closes[closes.length - 61]) * 100 : 0;
  const p4h = closes.length >= 241 ? ((price - closes[closes.length - 241]) / closes[closes.length - 241]) * 100 : 0;
  // price24hPcnt desde el ticker
  const p24h = ticker ? ticker.price24hPcnt : 0;

  // Dirección principal de la tendencia
  const dirUp = p4h !== 0 ? p4h > 0 : p1h >= 0;
  const sgn = dirUp ? 1 : -1;

  let score = 0;
  const ok = [], bad = [];

  // Criterio 1: Liquidez (0-15 pts)
  const turn = ticker ? ticker.turnover24h : 0;
  if (turn >= 100e6) { score += 15; ok.push('liquidez alta (>=100M)'); }
  else if (turn >= 30e6) { score += 10; ok.push('liquidez aceptable'); }
  else if (turn >= 10e6) { score += 5; bad.push('liquidez justa'); }
  else { bad.push('ilíquida (<10M)'); }

  // Criterio 2: Tendencia multi-TF (0-15 pts)
  const tfs = [p5m, p1h, p4h, p24h].filter(v => v !== 0);
  if (tfs.length >= 2) {
    const pos = tfs.filter(v => v > 0).length;
    const count = dirUp ? pos : (tfs.length - pos);
    const total = tfs.length;
    if (count === total && total >= 3) { score += 15; ok.push(`tendencia alineada ${count}/${total} TFs`); }
    else if (count >= 3) { score += 10; ok.push(`tendencia ${count}/${total} TFs`); }
    else { score += 5; bad.push('temporalidades en conflicto'); }
  } else {
    bad.push('temporalidades insuficientes');
  }

  // Criterio 3: Flujo real CVD (0-15 pts)
  const vol5m = klines.slice(-5).reduce((sum, k) => sum + k.turnover, 0);
  let cvd5m = 0;
  const since5m = nowMs - 300_000;
  for (const tr of trades) {
    if (tr.ts >= since5m) {
      cvd5m += (tr.side === 'Buy' ? 1 : -1) * tr.size * (tr.price || 0);
    }
  }
  if (vol5m > 0) {
    const ratio = (cvd5m * sgn) / vol5m;
    if (ratio > 0.15) { score += 15; ok.push('flujo agresor fuerte a favor'); }
    else if (ratio > 0.03) { score += 9; ok.push('flujo a favor'); }
    else if (ratio > -0.05) { score += 4; }
    else { bad.push('CVD en contra (divergencia de flujo)'); }
  } else {
    bad.push('sin volumen');
  }

  // Criterio 4: OI saludable (0-15 pts)
  const oi1h = oiSeries.length >= 13 ? (oiSeries[oiSeries.length - 1].oi - oiSeries[oiSeries.length - 13].oi) / oiSeries[oiSeries.length - 13].oi : 0;
  const oi4h = oiSeries.length >= 49 ? (oiSeries[oiSeries.length - 1].oi - oiSeries[oiSeries.length - 49].oi) / oiSeries[oiSeries.length - 49].oi : 0;
  if (oi1h > 0.002 && oi4h > 0) { score += 10; ok.push('OI creciendo (dinero nuevo)'); }
  else if (oi1h > 0) { score += 5; }
  else { bad.push('OI cayendo'); }

  // Streak de OI (últimos 3 snapshots incrementando)
  const isIncreasing = oiSeries.length >= 4 && oiSeries.slice(-4).every((x, i, arr) => i === 0 || x.oi > arr[i-1].oi);
  if (isIncreasing) { score += 5; ok.push('acumulación de OI sostenida'); }

  // Criterio 5: Funding controlado (0-10 pts)
  const fr = currentFunding ?? 0;
  const overheated = dirUp ? fr > 0.0005 : fr < -0.0005;
  if (overheated) { bad.push('funding sobrecalentado (euforia/apalancamiento estirado)'); }
  else if (Math.abs(fr) <= 0.0002) { score += 10; ok.push('funding equilibrado'); }
  else { score += 5; }

  // Criterio 6: Sin liquidación en contra (0-10 pts)
  let liqAgainst = 0;
  const since5mLiqs = nowMs - 300_000;
  for (const l of liqs) {
    if (l.ts >= since5mLiqs) {
      if (dirUp && l.side === 'Sell') liqAgainst += l.notional;
      if (!dirUp && l.side === 'Buy') liqAgainst += l.notional;
    }
  }
  if (liqAgainst > 100000) { bad.push('cascada de liquidaciones en contra'); }
  else if (liqAgainst > 30000) { score += 4; }
  else { score += 10; }

  // Criterio 7: No sobre-extendida (0-10 pts)
  const atr1h = atrVal * Math.sqrt(60);
  const mv = closes.length >= 61 ? Math.abs(price - closes[closes.length - 61]) : 0;
  if (atr1h > 0) {
    const ext = mv / atr1h;
    if (ext > 2.5) { bad.push(`sobre-extendida (${ext.toFixed(1)}xATR)`); }
    else if (ext > 1.8) { score += 5; }
    else { score += 10; }
  } else {
    score += 5;
  }

  // Si no cumple el score de salud mínimo configurado, no operamos
  if (score < C.MIN_HEALTH_SCORE) return null;

  const side = dirUp ? 'long' : 'short';
  const { stop, takeProfit, risk } = levels(side, price, atrVal, price, C);
  if (risk <= 0) return null;

  return {
    symbol: ctx.symbol,
    side,
    strategy: 'health',
    price,
    atr: atrVal,
    stop,
    takeProfit,
    score,
    reason: `Salud ${score}% | Criterios aprobados: ${ok.join(' · ')}${bad.length ? ' | Criterios fallidos: ' + bad.join(' · ') : ''}`,
    components: { healthScore: score, okChecks: ok, badChecks: bad }
  };
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
  vwapReclaim, fundingFade, breakoutOiCvd, fakeoutFade, momentumDelta, health,
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

  const allowed = (ALLOWED[reg.regime] || []).filter(name => !(C.DISABLED_STRATEGIES || []).includes(name));
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
