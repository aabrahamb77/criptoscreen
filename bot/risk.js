'use strict';
/**
 * bot/risk.js
 * Capa de gestión de riesgo que separa a los rentables del resto:
 *  - CircuitBreaker : corta el día tras pérdida máxima o racha de pérdidas.
 *  - correlationGuard : evita amontonar posiciones correlacionadas / mismo lado.
 *  - suggestSize    : tamaño por riesgo (ATR) para mostrar en el screener.
 */
const C = require('./config');

class CircuitBreaker {
  constructor(opts = {}) {
    this.maxDailyLossPct = opts.maxDailyLossPct ?? C.MAX_DAILY_LOSS_PCT;
    this.maxLossStreak = opts.maxLossStreak ?? C.MAX_LOSS_STREAK;
    this.dayKey = null;
    this.dayStartEquity = C.START_EQUITY;
    this.dayPnl = 0;
    this.lossStreak = 0;
    this.halted = false;
    this.haltReason = null;
  }

  _today() { return new Date().toISOString().slice(0, 10); }

  rollover(equity) {
    const k = this._today();
    if (k !== this.dayKey) {
      this.dayKey = k; this.dayStartEquity = equity;
      this.dayPnl = 0; this.lossStreak = 0; this.halted = false; this.haltReason = null;
    }
  }

  /** Llamar tras CADA trade cerrado. */
  onClosedTrade(pnl) {
    this.dayPnl += pnl;
    if (pnl <= 0) this.lossStreak++; else this.lossStreak = 0;
    if (this.dayStartEquity > 0 && this.dayPnl <= -this.maxDailyLossPct * this.dayStartEquity) {
      this.halted = true; this.haltReason = `Pérdida diaria máxima (${(this.maxDailyLossPct * 100).toFixed(1)}%)`;
    }
    if (this.lossStreak >= this.maxLossStreak) {
      this.halted = true; this.haltReason = `Racha de ${this.lossStreak} pérdidas`;
    }
  }

  /**
   * Rehidrata el día tras un reinicio: reconstruye dayStartEquity, dayPnl y la
   * racha de pérdidas a partir de los trades cerrados HOY (UTC), para que el
   * circuit breaker no "olvide" un mal día por reiniciar el proceso.
   */
  hydrate(equityNow, todayTrades = []) {
    this.dayKey = this._today();
    const dayPnl = todayTrades.reduce((a, t) => a + (t.pnl || 0), 0);
    this.dayStartEquity = equityNow - dayPnl;
    this.dayPnl = 0; this.lossStreak = 0; this.halted = false; this.haltReason = null;
    for (const t of todayTrades) this.onClosedTrade(t.pnl || 0);
  }

  /** ¿Se pueden abrir nuevas posiciones ahora? */
  canTrade(equity) { this.rollover(equity); return !this.halted; }

  state() {
    return {
      halted: this.halted, reason: this.haltReason,
      dayPnl: +this.dayPnl.toFixed(2), lossStreak: this.lossStreak,
      dayPnlPct: this.dayStartEquity ? +((this.dayPnl / this.dayStartEquity) * 100).toFixed(2) : 0,
    };
  }
}

/**
 * Evita correlación: no más de MAX_SAME_SIDE posiciones en el mismo lado, y
 * no abrir una alt long si BTC está débil (o alt short si BTC está fuerte).
 * `openPositions` = array de posiciones; `sig` = señal candidata.
 */
function correlationGuard(openPositions, sig, btcRegime) {
  const sameSide = openPositions.filter(p => p.side === sig.side).length;
  if (sameSide >= (C.MAX_SAME_SIDE ?? 3)) {
    return { ok: false, reason: `Ya hay ${sameSide} posiciones ${sig.side}` };
  }
  const isBtc = sig.symbol === 'BTC' || sig.symbol === 'BTCUSDT';
  if (btcRegime && !isBtc) {
    if (sig.side === 'long' && btcRegime.regime === 'trend' && btcRegime.dir === 'down') {
      return { ok: false, reason: 'BTC en tendencia bajista: evito longs en alts' };
    }
    if (sig.side === 'short' && btcRegime.regime === 'trend' && btcRegime.dir === 'up') {
      return { ok: false, reason: 'BTC en tendencia alcista: evito shorts en alts' };
    }
  }
  return { ok: true };
}

/** Tamaño sugerido por riesgo: arriesga riskPct del equity con stop a stopDist. */
function suggestSize(equity, entry, stop, riskPct = C.RISK_PCT) {
  const dist = Math.abs(entry - stop);
  if (dist <= 0) return { size: 0, notional: 0, riskCash: 0 };
  const riskCash = equity * riskPct;
  const size = riskCash / dist;
  return { size: +size.toFixed(6), notional: +(size * entry).toFixed(2), riskCash: +riskCash.toFixed(2) };
}

module.exports = { CircuitBreaker, correlationGuard, suggestSize };
