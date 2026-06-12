/* public/lxr.js
 * Módulo COMPARTIDO (UMD): métricas (CVD, divergencia, funding z-score,
 * liquidation pressure, ATR, composite score) + indicadores + estrategia LXR.
 *
 * Navegador: se carga con <script src="/lxr.js"></script> ANTES del script
 * principal y expone todo bajo window.LXR.
 * Node: bot/metrics.js y bot/indicators.js hacen require de este archivo,
 * así la lógica vive en UN solo sitio y no puede divergir.
 *
 * Pensado para enchufarse a las estructuras que ya tienes en index.html:
 *   - velas de Bybit (kline arrays),
 *   - oiSnaps / open-interest,
 *   - liqEvents (la barra ⚡LIQ),
 *   - y un nuevo buffer de trades para el CVD (LXR.CVD).
 */
(function (global) {
  'use strict';

  // ---- estadística base ----
  function zscore(value, series) {
    const n = series.length;
    if (n < 5) return 0;
    const mean = series.reduce((a, b) => a + b, 0) / n;
    const varr = series.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    const std = Math.sqrt(varr);
    return std === 0 ? 0 : (value - mean) / std;
  }
  const pctChange = (nw, old) => (!old ? 0 : ((nw - old) / Math.abs(old)) * 100);
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  function atr(highs, lows, closes, period = 14) {
    const n = closes.length;
    if (n < period + 1) return 0;
    const trs = [];
    for (let i = 1; i < n; i++) {
      trs.push(Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      ));
    }
    return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  }
  const atrNormalize = (move, a) => (a <= 0 ? 0 : move / a);

  // ---- CVD ----
  function cvdFromTrades(trades, sinceTs) {
    let cvd = 0;
    for (const t of trades) {
      if (sinceTs != null && t.ts < sinceTs) continue;
      cvd += t.side === 'Buy' ? t.size : -t.size;
    }
    return cvd;
  }
  function cvdDivergence(priceNow, pricePrev, cvdNow, cvdPrev) {
    if (priceNow < pricePrev && cvdNow > cvdPrev) return 1;
    if (priceNow > pricePrev && cvdNow < cvdPrev) return -1;
    return 0;
  }

  const fundingZscore = (current, history) => zscore(current, history);

  /* liqs: [{ts, side:'Buy'|'Sell', notional}]
   * Bybit allLiquidation: side 'Sell' = largo liquidado (bajista) -> 'long_liq'
   *                       side 'Buy'  = corto liquidado (alcista) -> 'short_liq' */
  function liquidationPressure(liqs, windowSec, baselineSec, nowMs) {
    const winStart = nowMs - windowSec * 1000;
    const baseStart = nowMs - baselineSec * 1000;
    const buckets = new Array(Math.max(1, Math.floor(baselineSec / Math.max(windowSec, 1)))).fill(0);
    let longLiq = 0, shortLiq = 0, windowUsd = 0;
    for (const e of liqs) {
      if (e.ts < baseStart) continue;
      const idx = Math.floor((nowMs - e.ts) / (windowSec * 1000));
      if (idx >= 0 && idx < buckets.length) buckets[idx] += e.notional;
      if (e.ts >= winStart) {
        windowUsd += e.notional;
        if (e.side === 'Sell') longLiq += e.notional; else shortLiq += e.notional;
      }
    }
    const z = zscore(windowUsd, buckets);
    const total = longLiq + shortLiq;
    if (total <= 0) return { z: 0, dominance: 0, direction: 'none', windowUsd: 0 };
    return longLiq >= shortLiq
      ? { z, dominance: longLiq / total, direction: 'long_liq', windowUsd }
      : { z, dominance: shortLiq / total, direction: 'short_liq', windowUsd };
  }

  /* Adapta tu liqEvents ({symbol, isLong, usdVal, ts}) al formato de arriba.
   * isLong = true -> se liquidó un largo -> side 'Sell'. */
  function liqEventsToInput(liqEvents, symbolNoUSDT) {
    return liqEvents
      .filter(e => e.symbol === symbolNoUSDT)
      .map(e => ({ ts: e.ts, side: e.isLong ? 'Sell' : 'Buy', notional: e.usdVal }));
  }

  function oiPriceRegime(oi, p) {
    if (oi >= 0 && p >= 0) return 'LONG';
    if (oi >= 0 && p < 0) return 'SHORT';
    if (oi < 0 && p >= 0) return 'SQUEEZE';
    return 'LIQ';
  }

  function compositeScalpScore(oiChgPct, priceMoveAtr, cvdShort, cvdTrend, fundingZ, liq) {
    const flow = Math.tanh((cvdShort + 0.5 * cvdTrend) / 1000);
    const liqInt = clamp((liq.z || 0) / 4, 0, 1) * (liq.dominance || 0);
    const liqSigned = liqInt * (liq.direction === 'long_liq' ? 1 : liq.direction === 'short_liq' ? -1 : 0);
    const oiMom = Math.tanh(oiChgPct / 2);
    const fund = -Math.tanh(fundingZ / 3);
    const ext = clamp(Math.abs(priceMoveAtr) / 3, 0, 1);
    const directional = 0.35 * flow + 0.25 * liqSigned + 0.20 * oiMom + 0.10 * fund;
    const intensity = Math.abs(directional) * 0.9 + 0.10 * ext;
    const score = Math.round(clamp(intensity, 0, 1) * 1000) / 10;
    let bias = 'neutral';
    if (directional > 0.08) bias = 'long'; else if (directional < -0.08) bias = 'short';
    return { score, bias, directional: Math.round(directional * 1000) / 1000 };
  }

  // ---- buffer de CVD por símbolo (alimentado desde publicTrade WS) ----
  const CVD = {
    _buf: new Map(),            // symbol(sin USDT) -> [{ts,side,size,price}]
    maxAgeMs: 3600 * 1000,
    push(symbolNoUSDT, ts, side, size, price) {
      if (!this._buf.has(symbolNoUSDT)) this._buf.set(symbolNoUSDT, []);
      const arr = this._buf.get(symbolNoUSDT);
      arr.push({ ts, side, size, price });
      const cut = Date.now() - this.maxAgeMs;
      while (arr.length && arr[0].ts < cut) arr.shift();
    },
    get(symbolNoUSDT) { return this._buf.get(symbolNoUSDT) || []; },
  };

  // ---- configuración por defecto (alineada con bot/config.js) ----
  const CFG = {
    ATR_PERIOD: 14, CVD_WINDOW_SEC: 60, CVD_TREND_SEC: 300,
    LIQ_WINDOW_SEC: 90, LIQ_BASELINE_SEC: 3600,
    LIQ_Z_THRESHOLD: 2.0, LIQ_DOMINANCE: 0.70, EXT_ATR_MULT: 1.5,
    OI_DROP_PCT: 0.30, FUNDING_Z_CONFLUENCE: 1.5, MIN_SIGNAL_SCORE: 60,
    STOP_ATR_MULT: 1.2, TP_R_MULTIPLE: 1.5,
  };

  /* Evalúa LXR.
   * params: { symbol, klines:[{high,low,close}], oiSeries:[{oi}],
   *           fundingHist:[num], currentFunding:num,
   *           trades:[{ts,side,size}], liqs:[{ts,side,notional}], nowMs, cfg? }
   * Devuelve la señal o null. */
  function evaluate(params) {
    const c = Object.assign({}, CFG, params.cfg || {});
    const { symbol, klines, oiSeries, fundingHist, currentFunding, trades, liqs } = params;
    const nowMs = params.nowMs || Date.now();
    if (!klines || klines.length < c.ATR_PERIOD + 5 || !oiSeries || oiSeries.length < 3) return null;

    const highs = klines.map(k => k.high), lows = klines.map(k => k.low), closes = klines.map(k => k.close);
    const price = closes[closes.length - 1];
    const atrVal = atr(highs, lows, closes, c.ATR_PERIOD);
    if (atrVal <= 0) return null;

    const liq = liquidationPressure(liqs, c.LIQ_WINDOW_SEC, c.LIQ_BASELINE_SEC, nowMs);
    if (liq.direction === 'none' || liq.z < c.LIQ_Z_THRESHOLD || liq.dominance < c.LIQ_DOMINANCE) return null;

    const recent = klines.slice(-3);
    let extreme, impulse, side;
    if (liq.direction === 'long_liq') {
      extreme = Math.min(...recent.map(k => k.low));
      impulse = Math.max(...recent.map(k => k.high)) - extreme; side = 'long';
    } else {
      extreme = Math.max(...recent.map(k => k.high));
      impulse = extreme - Math.min(...recent.map(k => k.low)); side = 'short';
    }
    const moveAtr = atrNormalize(impulse, atrVal);
    if (moveAtr < c.EXT_ATR_MULT) return null;

    const oiNow = oiSeries[oiSeries.length - 1].oi, oiPrev = oiSeries[oiSeries.length - 3].oi;
    const oiChg = pctChange(oiNow, oiPrev);
    const oiConfirms = oiChg <= -c.OI_DROP_PCT;

    const cvdShort = cvdFromTrades(trades, nowMs - c.CVD_WINDOW_SEC * 1000);
    const cvdPrev = cvdFromTrades(trades, nowMs - 2 * c.CVD_WINDOW_SEC * 1000) - cvdShort;
    const cvdTrend = cvdFromTrades(trades, nowMs - c.CVD_TREND_SEC * 1000);
    const diverg = cvdDivergence(price, closes[closes.length - 2], cvdShort, cvdPrev);
    const flowConfirms = side === 'long' ? (diverg === 1 || cvdShort > cvdPrev) : (diverg === -1 || cvdShort < cvdPrev);

    const fz = fundingZscore(currentFunding, fundingHist || []);
    const fundingConfirms = side === 'long' ? fz <= -c.FUNDING_Z_CONFLUENCE : fz >= c.FUNDING_Z_CONFLUENCE;

    let score = 0;
    score += Math.min(liq.z / 4, 1) * 35;
    score += Math.min(moveAtr / 3, 1) * 20;
    score += oiConfirms ? 15 : 0;
    score += flowConfirms ? 20 : 0;
    score += fundingConfirms ? 10 : 0;
    score = Math.round(score * 10) / 10;
    if (!(flowConfirms || oiConfirms) || score < c.MIN_SIGNAL_SCORE) return null;

    let stop, takeProfit, risk;
    if (side === 'long') { stop = extreme - c.STOP_ATR_MULT * atrVal; risk = price - stop; takeProfit = price + c.TP_R_MULTIPLE * risk; }
    else { stop = extreme + c.STOP_ATR_MULT * atrVal; risk = stop - price; takeProfit = price - c.TP_R_MULTIPLE * risk; }
    if (risk <= 0) return null;

    return {
      symbol, side, price, atr: atrVal, stop, takeProfit, score,
      reason: `Cascada ${liq.direction} z=${liq.z.toFixed(1)} dom=${(liq.dominance * 100).toFixed(0)}% | move=${moveAtr.toFixed(1)}ATR | OI ${oiChg.toFixed(2)}% | flow=${flowConfirms ? 'ok' : 'no'} | fundZ=${fz.toFixed(1)}`,
      components: { liqZ: +liq.z.toFixed(2), liqDom: +liq.dominance.toFixed(2), moveAtr: +moveAtr.toFixed(2), oiChgPct: +oiChg.toFixed(2), cvdShort: +cvdShort.toFixed(2), cvdTrend: +cvdTrend.toFixed(2), divergence: diverg, fundingZ: +fz.toFixed(2) },
    };
  }

  // ===== Indicadores avanzados (espejo de bot/indicators.js) =====
  function adx(highs, lows, closes, period = 14) {
    const n = closes.length; if (n < period * 2) return 0;
    let trS = 0, plusS = 0, minusS = 0;
    for (let i = 1; i <= period; i++) {
      const up = highs[i] - highs[i - 1], dn = lows[i - 1] - lows[i];
      trS += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
      plusS += up > dn && up > 0 ? up : 0; minusS += dn > up && dn > 0 ? dn : 0;
    }
    const dxs = [];
    for (let i = period + 1; i < n; i++) {
      const up = highs[i] - highs[i - 1], dn = lows[i - 1] - lows[i];
      const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
      trS = trS - trS / period + tr;
      plusS = plusS - plusS / period + (up > dn && up > 0 ? up : 0);
      minusS = minusS - minusS / period + (dn > up && dn > 0 ? dn : 0);
      const pDI = trS ? plusS / trS * 100 : 0, mDI = trS ? minusS / trS * 100 : 0, den = pDI + mDI;
      dxs.push(den ? Math.abs(pDI - mDI) / den * 100 : 0);
    }
    if (!dxs.length) return 0;
    return dxs.slice(-period).reduce((a, b) => a + b, 0) / Math.min(period, dxs.length);
  }
  function efficiencyRatio(closes, period = 20) {
    const n = closes.length; if (n < period + 1) return 0;
    const seg = closes.slice(-(period + 1));
    const change = Math.abs(seg[seg.length - 1] - seg[0]);
    let vol = 0; for (let i = 1; i < seg.length; i++) vol += Math.abs(seg[i] - seg[i - 1]);
    return vol ? change / vol : 0;
  }
  function regime(highs, lows, closes, o = {}) {
    const a = adx(highs, lows, closes, o.adxPeriod || 14);
    const er = efficiencyRatio(closes, o.erPeriod || 20);
    const price = closes[closes.length - 1];
    const ref = closes[closes.length - 1 - Math.min(o.erPeriod || 20, closes.length - 1)];
    const dir = price > ref * 1.001 ? 'up' : price < ref * 0.999 ? 'down' : 'flat';
    let trSum = 0; const k = Math.min(14, closes.length - 1);
    for (let i = closes.length - k; i < closes.length; i++) trSum += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    const atrPct = price ? trSum / k / price * 100 : 0;
    let r; if (a >= (o.adxTrend || 25) || er >= (o.erTrend || 0.5)) r = 'trend';
    else if (atrPct >= (o.volPct || 0.25) && a < 20) r = 'volatile'; else r = 'range';
    return { regime: r, dir, adx: +a.toFixed(1), er: +er.toFixed(2), atrPct: +atrPct.toFixed(3) };
  }
  const pctRet = (closes, lb) => (closes.length < lb + 1 ? 0 : (closes[closes.length - 1] - closes[closes.length - 1 - lb]) / closes[closes.length - 1 - lb] * 100);
  const relativeStrength = (s, btc, lb = 60) => +(pctRet(s, lb) - pctRet(btc, lb)).toFixed(3);
  function anchoredVWAP(klines, anchorIdx = 0) {
    let num = 0, den = 0;
    for (let i = Math.max(0, anchorIdx); i < klines.length; i++) { const k = klines[i]; const tp = (k.high + k.low + k.close) / 3; num += tp * k.volume; den += k.volume; }
    return den ? num / den : klines[klines.length - 1].close;
  }
  const basis = (perp, index) => (!index ? 0 : +((perp - index) / index * 100).toFixed(4));
  function liquidationHeatmap(klines, currentPrice, o = {}) {
    const leverages = o.leverages || [25, 50, 100], lookback = o.lookback || 60, bucketPct = o.bucketPct || 0.0025;
    const rows = klines.slice(-lookback), buckets = new Map();
    const add = (price, side, w, lev) => { const key = Math.round(price / (currentPrice * bucketPct)); const b = buckets.get(key) || { price: key * currentPrice * bucketPct, side, weight: 0, levs: new Set() }; b.weight += w; b.levs.add(lev); b.side = side; buckets.set(key, b); };
    for (const k of rows) { const entry = (k.high + k.low + k.close) / 3, w = k.volume || 1; for (const L of leverages) { add(entry * (1 - 1 / L), 'below', w / L, L); add(entry * (1 + 1 / L), 'above', w / L, L); } }
    return [...buckets.values()].map(b => ({ price: +b.price.toFixed(8), side: b.side, weight: +b.weight.toFixed(2), levs: [...b.levs].sort((a, c) => a - c) })).sort((a, b) => b.weight - a.weight).slice(0, o.top || 8);
  }
  function orderbookImbalance(bids, asks, depth = 20) {
    const sum = l => l.slice(0, depth).reduce((a, x) => a + (+x[1]), 0);
    const b = sum(bids), a = sum(asks), t = b + a; return t ? +((b - a) / t).toFixed(3) : 0;
  }

  // ===== Helper UI: semáforo de régimen (devuelve HTML) =====
  function regimeBadge(reg) {
    if (!reg) return '';
    const map = { trend: ['#0088ff', 'TENDENCIA'], volatile: ['#e0a020', 'VOLÁTIL'], range: ['#5a6a80', 'RANGO'] };
    const [c, label] = map[reg.regime] || ['#5a6a80', '—'];
    const arrow = reg.dir === 'up' ? '↑' : reg.dir === 'down' ? '↓' : '·';
    return `<span style="font-size:9px;font-weight:700;color:${c};border:1px solid ${c}55;background:${c}18;border-radius:5px;padding:1px 6px" title="ADX ${reg.adx} · ER ${reg.er}">${label} ${arrow}</span>`;
  }

  const API = {
    metrics: { zscore, pctChange, clamp, atr, atrNormalize, cvdFromTrades, cvdDivergence, fundingZscore, liquidationPressure, oiPriceRegime, compositeScalpScore },
    ind: { adx, efficiencyRatio, regime, relativeStrength, pctRet, anchoredVWAP, basis, liquidationHeatmap, orderbookImbalance },
    ui: { regimeBadge },
    CVD, CFG, evaluate, liqEventsToInput,
  };
  // UMD: navegador (window.LXR) y Node (require('../public/lxr.js')).
  // bot/metrics.js y bot/indicators.js reexportan desde aquí — única fuente de verdad.
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (global) global.LXR = API;
})(typeof window !== 'undefined' ? window : globalThis);
