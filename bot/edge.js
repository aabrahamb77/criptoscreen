'use strict';
/**
 * bot/edge.js — Capa de EDGE del bot v2.
 * Lleva al servidor las señales que validamos en el frontend y las convierte
 * en tres controles sobre cada operación:
 *
 *  1. riskLight()    — semáforo de mercado server-side (0-100): en rojo no se
 *                      abre nada; en amarillo se opera a mitad de tamaño.
 *  2. qualityGate()  — "salud" mínima por operación: liquidez, CVD a favor,
 *                      OI, funding sin euforia y (solo para continuación)
 *                      alineación de temporalidades y no sobre-extensión.
 *  3. strategyStats()— asignación adaptativa: una estrategia con expectancy
 *                      negativa tras ≥15 trades queda DESACTIVADA sola.
 *
 * Nada de esto garantiza rentabilidad: garantiza que el bot solo opere cuando
 * las condiciones que medimos están a favor, y que deje de usar lo que
 * demuestre no funcionar. El veredicto lo dan los datos en getState().
 */
const C = require('./config');
const bybit = require('./bybit');
const m = require('./metrics');
const ind = require('./indicators');

// Estrategias de REVERSIÓN: su setup ES la sobre-extensión y operan contra el
// movimiento reciente — a ellas no se les exige alineación ni "no extensión".
const REVERSION = new Set(['lxr', 'vwapReclaim', 'fundingFade', 'fakeoutFade']);

const TICKER_TTL = 5 * 60_000;
const _tickerCache = new Map();
async function tickerCached(symbol) {
  const hit = _tickerCache.get(symbol);
  if (hit && Date.now() - hit.ts < TICKER_TTL) return hit.t;
  try {
    const t = await bybit.ticker(symbol);
    _tickerCache.set(symbol, { ts: Date.now(), t });
    return t;
  } catch (_) { return hit ? hit.t : null; }
}

class EdgeState {
  constructor() {
    this.symCtx = new Map();   // symbol → { chg1hPct, funding, ts }
    this.lastGuard = { risk: 0, level: 'v', scale: 1, why: [] };
    this._skips = { guard: 0, quality: 0, disabled: 0 }; // contadores para getState
  }

  record(symbol, chg1hPct) {
    const prev = this.symCtx.get(symbol) || {};
    this.symCtx.set(symbol, { ...prev, chg1hPct, ts: Date.now() });
  }
  recordFunding(symbol, funding) {
    const prev = this.symCtx.get(symbol) || {};
    this.symCtx.set(symbol, { ...prev, funding, ts: Date.now() });
  }

  /**
   * Semáforo de mercado (server): BTC en ×ATR, cascadas de liquidación del
   * universo, chop direccional y funding estirado. scale: 1 / 0.5 / 0.
   */
  riskLight(btcKlines, liqUsd5m) {
    let risk = 0;
    const why = [];

    // 1) BTC moviéndose más de lo normal (×ATR de 1h, desde velas 1m)
    if (btcKlines && btcKlines.length > 70) {
      const highs = btcKlines.map(k => k.high), lows = btcKlines.map(k => k.low), closes = btcKlines.map(k => k.close);
      const atr1h = m.atr(highs, lows, closes, 14) * Math.sqrt(60); // ATR 1m escalado a 1h
      const chg1h = Math.abs(closes[closes.length - 1] - closes[closes.length - 61]);
      if (atr1h > 0) {
        const x = chg1h / atr1h;
        if      (x >= 2)   { risk += 30; why.push(`BTC ${x.toFixed(1)}×ATR en 1h — extremo`); }
        else if (x >= 1.2) { risk += 18; why.push(`BTC ${x.toFixed(1)}×ATR en 1h — elevado`); }
        else if (x >= 0.7)   risk += 8;
      }
    }

    // 2) cascadas de liquidación en el universo del bot (5 min)
    if      (liqUsd5m > 2e6)   { risk += 30; why.push(`cascada de liquidaciones: $${(liqUsd5m / 1e6).toFixed(1)}M en 5m`); }
    else if (liqUsd5m > 0.5e6) { risk += 15; why.push(`liquidaciones elevadas: $${(liqUsd5m / 1e6).toFixed(1)}M en 5m`); }
    else if (liqUsd5m > 0.1e6)   risk += 6;

    // 3) chop: mitad del universo subiendo, mitad bajando
    const ctxs = [...this.symCtx.values()].filter(c => c.chg1hPct != null && Date.now() - c.ts < 5 * 60_000);
    if (ctxs.length >= 6) {
      const up = ctxs.filter(c => c.chg1hPct > 0).length;
      const dirStrength = Math.abs(up / ctxs.length - 0.5) * 2;
      if      (dirStrength < 0.2) { risk += 20; why.push(`sin dirección: ${up}/${ctxs.length} al alza (chop)`); }
      else if (dirStrength < 0.4)   risk += 10;

      // 4) funding estirado en buena parte del universo (0.0005 = 0.05%)
      const withF = ctxs.filter(c => c.funding != null);
      if (withF.length >= 5) {
        const stretched = withF.filter(c => Math.abs(c.funding) >= 0.0005).length;
        if      (stretched >= withF.length * 0.5)  { risk += 20; why.push(`${stretched}/${withF.length} símbolos con funding extremo`); }
        else if (stretched >= withF.length * 0.25)   risk += 10;
      }
    }

    const level = risk >= 60 ? 'r' : risk >= 30 ? 'a' : 'v';
    const scale = level === 'r' ? 0 : level === 'a' ? 0.5 : 1;
    this.lastGuard = { risk, level, scale, why };
    return this.lastGuard;
  }

  /**
   * Salud mínima por operación. Criterios según tipo de estrategia:
   * continuación exige alineación y no sobre-extensión; reversión no (es su setup).
   * ok = score ≥ 60% del máximo aplicable.
   */
  async qualityGate(ctx, sig) {
    const dirUp = sig.side === 'long';
    const sgn = dirUp ? 1 : -1;
    const reversion = REVERSION.has(sig.strategy);
    let score = 0, max = 0;
    const bad = [];

    // Liquidez (20)
    max += 20;
    const t = await tickerCached(ctx.symbol);
    const turn = t ? t.turnover24h : 0;
    if      (turn >= 100e6) score += 20;
    else if (turn >= 30e6)  score += 12;
    else if (turn >= 10e6)  score += 5;
    else bad.push('ilíquida (<$10M/24h)');

    // CVD 5m a favor del lado (20)
    max += 20;
    let cvd = 0;
    const since = ctx.nowMs - 300_000;
    for (const tr of ctx.trades) if (tr.ts >= since) cvd += (tr.side === 'Buy' ? 1 : -1) * tr.size * (tr.price || 0);
    if (cvd * sgn > 0) score += 20;
    else if (cvd === 0) score += 8;
    else bad.push('CVD en contra');

    // OI con interés (15): que el movimiento tenga participación
    max += 15;
    if (ctx.oiSeries.length >= 3) {
      const chg = m.pctChange(ctx.oiSeries[ctx.oiSeries.length - 1].oi, ctx.oiSeries[ctx.oiSeries.length - 3].oi);
      if (chg > 0 || reversion) score += 15; // en reversión el OI suele caer (cierre forzado): no penaliza
      else bad.push('OI cayendo');
    } else score += 7;

    // Funding sin euforia en la dirección (15)
    max += 15;
    const f = ctx.currentFunding ?? 0;
    if (dirUp ? f <= 0.0005 : f >= -0.0005) score += 15;
    else bad.push('funding sobrecalentado');

    if (!reversion) {
      const closes = ctx.klines.map(k => k.close);
      // No sobre-extendida (15)
      max += 15;
      if (closes.length > 70) {
        const atr1h = m.atr(ctx.klines.map(k => k.high), ctx.klines.map(k => k.low), closes, 14) * Math.sqrt(60);
        const mv = Math.abs(closes[closes.length - 1] - closes[closes.length - 61]);
        if (atr1h > 0 && mv / atr1h > 2.5) bad.push('sobre-extendida (>2.5×ATR)');
        else score += 15;
      } else score += 7;
      // Alineación 15m/1h con el lado (15)
      max += 15;
      if (closes.length > 70) {
        const r15 = closes[closes.length - 1] - closes[closes.length - 16];
        const r60 = closes[closes.length - 1] - closes[closes.length - 61];
        if (dirUp ? (r15 > 0 && r60 > 0) : (r15 < 0 && r60 < 0)) score += 15;
        else bad.push('temporalidades en conflicto');
      } else score += 7;
    }

    const pct = max ? score / max : 0;
    return { ok: pct >= C.EDGE_MIN_QUALITY_PCT, score: Math.round(pct * 100), bad };
  }

  /**
   * Asignación adaptativa: expectancy por estrategia desde los trades cerrados.
   * Con ≥EDGE_DISABLE_MIN_TRADES y expectancy < EDGE_DISABLE_EXPECTANCY queda
   * desactivada — el bot deja de operar lo que demuestra no funcionar.
   */
  strategyStats(closedTrades) {
    const by = new Map();
    for (const tr of closedTrades) {
      const k = tr.strategy || 'desconocida';
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(tr);
    }
    const stats = {};
    const disabled = [];
    for (const [k, trades] of by) {
      const e = ind.expectancy(trades);
      stats[k] = e;
      if (k !== 'desconocida' && e.trades >= C.EDGE_DISABLE_MIN_TRADES && e.expectancyR < C.EDGE_DISABLE_EXPECTANCY) {
        disabled.push(k);
      }
    }
    return { stats, disabled };
  }

  skipped(kind) { this._skips[kind] = (this._skips[kind] || 0) + 1; }
  state() { return { guard: this.lastGuard, skips: this._skips }; }
}

module.exports = { EdgeState, REVERSION };
