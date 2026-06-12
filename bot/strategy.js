'use strict';
/**
 * bot/strategy.js
 * Estrategia LXR — Liquidation Exhaustion Reversal.
 * La lógica vive en public/lxr.js (módulo compartido UMD); aquí solo se
 * inyecta la configuración del bot y el baseline efectivo de liquidaciones
 * (acotado por la cobertura real del WebSocket para no inflar el z-score
 * tras una reconexión).
 */
const C = require('./config');
const LXR = require('../public/lxr.js');

function vwap(klines, lookback = 30) {
  const rows = klines.slice(-lookback);
  let num = 0, den = 0;
  for (const k of rows) { const tp = (k.high + k.low + k.close) / 3; num += tp * k.volume; den += k.volume; }
  return den ? num / den : rows[rows.length - 1].close;
}

function evaluate(ctx) {
  const cfg = {
    ATR_PERIOD: C.ATR_PERIOD,
    CVD_WINDOW_SEC: C.CVD_WINDOW_SEC,
    CVD_TREND_SEC: C.CVD_TREND_SEC,
    LIQ_WINDOW_SEC: C.LIQ_WINDOW_SEC,
    // baseline acotado por la cobertura del WS: con <5 buckets el z-score es 0
    // y la señal no dispara — evita falsos positivos tras reconectar.
    LIQ_BASELINE_SEC: Math.max(1, Math.min(C.LIQ_BASELINE_SEC, ctx.liqBaselineSec ?? C.LIQ_BASELINE_SEC)),
    LIQ_Z_THRESHOLD: C.LIQ_Z_THRESHOLD,
    LIQ_DOMINANCE: C.LIQ_DOMINANCE,
    EXT_ATR_MULT: C.EXT_ATR_MULT,
    OI_DROP_PCT: C.OI_DROP_PCT,
    FUNDING_Z_CONFLUENCE: C.FUNDING_Z_CONFLUENCE,
    MIN_SIGNAL_SCORE: C.MIN_SIGNAL_SCORE,
    STOP_ATR_MULT: C.STOP_ATR_MULT,
    TP_R_MULTIPLE: C.TP_R_MULTIPLE,
  };
  const sig = LXR.evaluate({
    symbol: ctx.symbol, klines: ctx.klines, oiSeries: ctx.oiSeries,
    fundingHist: ctx.fundingHist, currentFunding: ctx.currentFunding,
    trades: ctx.trades, liqs: ctx.liqs, nowMs: ctx.nowMs, cfg,
  });
  if (sig) sig.components.vwap = +vwap(ctx.klines).toFixed(8);
  return sig;
}

module.exports = { evaluate, vwap };
