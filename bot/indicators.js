'use strict';
/**
 * bot/indicators.js
 * Los indicadores compartidos con el frontend (ADX, efficiency ratio, régimen,
 * fuerza relativa, anchored VWAP, basis, heatmap de liquidaciones, imbalance)
 * se reexportan desde public/lxr.js (UMD) — única fuente de verdad.
 *
 * Aquí solo viven las métricas de backtest que el navegador no necesita:
 * expectancy y equityStats.
 */
const LXR = require('../public/lxr.js');

// ---------------------------------------------------------------------------
// Métricas de backtest / expectancy (solo Node)
// ---------------------------------------------------------------------------
function expectancy(trades) {
  const n = trades.length;
  if (!n) return { trades: 0 };
  const rs = trades.map(t => t.r_multiple ?? 0);
  const wins = rs.filter(r => r > 0), losses = rs.filter(r => r <= 0);
  const winRate = wins.length / n;
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 0;
  const exp = +(winRate * avgWin - (1 - winRate) * avgLoss).toFixed(3); // R esperado por trade
  return { trades: n, winRate: +(winRate * 100).toFixed(1), avgWinR: +avgWin.toFixed(2), avgLossR: +avgLoss.toFixed(2), expectancyR: exp };
}

/** Curva de equity -> max drawdown %, retorno total %, Sharpe simple (por trade). */
function equityStats(equitySeries) {
  if (equitySeries.length < 2) return {};
  let peak = equitySeries[0], maxDD = 0;
  const rets = [];
  for (let i = 1; i < equitySeries.length; i++) {
    peak = Math.max(peak, equitySeries[i]);
    maxDD = Math.max(maxDD, (peak - equitySeries[i]) / peak);
    rets.push((equitySeries[i] - equitySeries[i - 1]) / equitySeries[i - 1]);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length) || 1e-9;
  return {
    returnPct: +((equitySeries[equitySeries.length - 1] / equitySeries[0] - 1) * 100).toFixed(2),
    maxDrawdownPct: +(maxDD * 100).toFixed(2),
    sharpe: +(mean / sd * Math.sqrt(rets.length)).toFixed(2),
  };
}

module.exports = { ...LXR.ind, expectancy, equityStats };
