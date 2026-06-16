'use strict';
/**
 * bot/paperBroker.js
 * Motor de PAPER TRADING (simulado). Sizing por riesgo, fees, slippage,
 * SL/TP/trailing/timeout. Persiste trades cerrados en Turso/libsql si está
 * configurado (misma DB que usa la app); si no, guarda solo en memoria.
 *
 * NO envía órdenes reales a ningún exchange.
 */
const C = require('./config');

let client = null;
try {
  const { createClient } = require('@libsql/client');
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (url && authToken) client = createClient({ url, authToken });
} catch (_) { /* libsql no disponible: seguimos en memoria */ }

let _initDone = null;
async function ensureTable() {
  if (!client) return false;
  if (!_initDone) {
    _initDone = client.execute(`
      CREATE TABLE IF NOT EXISTS paper_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT, side TEXT,
        entry REAL, exit REAL, size REAL,
        pnl REAL, r_multiple REAL,
        reason_entry TEXT, reason_exit TEXT,
        score REAL, held_sec INTEGER,
        equity_after REAL, closed_at INTEGER,
        strategy TEXT
      )
    `)
      // migración para tablas creadas antes de la columna strategy
      .then(() => client.execute(`ALTER TABLE paper_trades ADD COLUMN strategy TEXT`).catch(() => {}))
      .then(() => true)
      .catch(e => { console.error('paper_trades init:', e.message); return false; });
  }
  return _initDone;
}

class PaperBroker {
  constructor() {
    this.equity = C.START_EQUITY;
    this.positions = new Map(); // symbol -> position
    this.closed = [];
    this.realizedPnl = 0;
  }

  canOpen(symbol) {
    return !this.positions.has(symbol) && this.positions.size < C.MAX_CONCURRENT;
  }

  /** riskScale: factor del semáforo (1 verde · 0.5 amarillo · 0 rojo). */
  open(sig, riskScale = 1) {
    if (!this.canOpen(sig.symbol) || riskScale <= 0) return null;
    const riskPerUnit = Math.abs(sig.price - sig.stop);
    if (riskPerUnit <= 0) return null;
    const size = (this.equity * C.RISK_PCT * riskScale) / riskPerUnit;

    const slip = sig.price * (C.SLIPPAGE_BPS / 10000);
    const entry = sig.side === 'long' ? sig.price + slip : sig.price - slip;
    this.equity -= entry * size * C.TAKER_FEE;

    const pos = {
      symbol: sig.symbol, side: sig.side, entry, size,
      stop: sig.stop, takeProfit: sig.takeProfit, atr: sig.atr,
      openedMs: Date.now(), score: sig.score, reason: sig.reason,
      strategy: sig.strategy || null, riskScale,
      maxFav: entry, trailActive: false, riskPerUnit,
    };
    this.positions.set(sig.symbol, pos);
    return pos;
  }

  _trail(pos, hi, lo) {
    const r = pos.riskPerUnit;
    if (r <= 0) return;
    if (pos.side === 'long') {
      pos.maxFav = Math.max(pos.maxFav, hi);
      if ((pos.maxFav - pos.entry) / r >= C.TRAIL_ACTIVATE_R) pos.trailActive = true;
      if (pos.trailActive) pos.stop = Math.max(pos.stop, pos.maxFav - C.TRAIL_ATR_MULT * pos.atr);
    } else {
      pos.maxFav = Math.min(pos.maxFav, lo);
      if ((pos.entry - pos.maxFav) / r >= C.TRAIL_ACTIVATE_R) pos.trailActive = true;
      if (pos.trailActive) pos.stop = Math.min(pos.stop, pos.maxFav + C.TRAIL_ATR_MULT * pos.atr);
    }
  }

  /**
   * Evaluación INTRAVELA: hi/lo son el máximo/mínimo observado (trades del WS)
   * desde la última revisión — no solo el close del ciclo. Reglas:
   *  - El cierre se ejecuta al PRECIO DEL TRIGGER (stop o TP), no al close.
   *  - Regla pesimista: si en el mismo intervalo se tocaron stop y TP,
   *    se asume que el stop se tocó primero.
   * Esto elimina el sesgo optimista que tenía evaluar solo con el close.
   */
  update(symbol, price, hi = price, lo = price) {
    const pos = this.positions.get(symbol);
    if (!pos) return;
    this._trail(pos, hi, lo);

    let reason = null, exitPrice = price;
    if (pos.side === 'long') {
      if (lo <= pos.stop) { reason = 'stop'; exitPrice = Math.min(pos.stop, price); }
      else if (hi >= pos.takeProfit) { reason = 'take_profit'; exitPrice = pos.takeProfit; }
    } else {
      if (hi >= pos.stop) { reason = 'stop'; exitPrice = Math.max(pos.stop, price); }
      else if (lo <= pos.takeProfit) { reason = 'take_profit'; exitPrice = pos.takeProfit; }
    }
    if (Date.now() - pos.openedMs > C.MAX_HOLD_SEC * 1000) {
      if (!reason) { reason = 'timeout'; exitPrice = price; }
    }
    if (reason) this._close(pos, exitPrice, reason);
  }

  _close(pos, price, reason) {
    const slip = price * (C.SLIPPAGE_BPS / 10000);
    const exit = pos.side === 'long' ? price - slip : price + slip;
    const gross = pos.side === 'long' ? (exit - pos.entry) * pos.size : (pos.entry - exit) * pos.size;
    const fee = exit * pos.size * C.TAKER_FEE;
    const pnl = gross - fee;
    this.equity += pnl;
    this.realizedPnl += pnl;

    const rec = {
      symbol: pos.symbol, side: pos.side,
      entry: +pos.entry.toFixed(8), exit: +exit.toFixed(8), size: +pos.size.toFixed(6),
      pnl: +pnl.toFixed(4),
      r_multiple: pos.riskPerUnit * pos.size ? +(pnl / (pos.riskPerUnit * pos.size)).toFixed(2) : 0,
      reason_entry: pos.reason, reason_exit: reason, score: pos.score,
      strategy: pos.strategy || null,
      held_sec: Math.round((Date.now() - pos.openedMs) / 1000),
      equity_after: +this.equity.toFixed(2), closed_at: Date.now(),
    };
    this.closed.push(rec);
    this.positions.delete(pos.symbol);
    this._persist(rec).catch(e => console.error('persist trade:', e.message));
    return rec;
  }

  /**
   * Rehidrata el estado desde Turso al arrancar: historial de trades cerrados,
   * equity (último equity_after) y PnL realizado. Así un reinicio del proceso
   * no resetea la cuenta a START_EQUITY. Devuelve true si se rehidrató.
   */
  async hydrate() {
    if (!(await ensureTable())) return false;
    try {
      const res = await client.execute(
        `SELECT symbol, side, entry, exit, size, pnl, r_multiple, reason_entry,
                reason_exit, score, held_sec, equity_after, closed_at, strategy
         FROM paper_trades ORDER BY closed_at ASC`
      );
      if (!res.rows.length) return false;
      this.closed = res.rows.map(r => ({
        symbol: r.symbol, side: r.side,
        entry: +r.entry, exit: +r.exit, size: +r.size,
        pnl: +r.pnl, r_multiple: +r.r_multiple,
        reason_entry: r.reason_entry, reason_exit: r.reason_exit,
        score: +r.score, held_sec: +r.held_sec,
        equity_after: +r.equity_after, closed_at: +r.closed_at,
        strategy: r.strategy || null,
      }));
      const last = this.closed[this.closed.length - 1];
      this.equity = +last.equity_after;
      this.realizedPnl = +this.closed.reduce((a, c) => a + c.pnl, 0).toFixed(4);
      return true;
    } catch (e) {
      console.error('hydrate paper_trades:', e.message);
      return false;
    }
  }

  async _persist(rec) {
    if (!(await ensureTable())) return;
    await client.execute({
      sql: `INSERT INTO paper_trades
        (symbol,side,entry,exit,size,pnl,r_multiple,reason_entry,reason_exit,score,held_sec,equity_after,closed_at,strategy)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [rec.symbol, rec.side, rec.entry, rec.exit, rec.size, rec.pnl, rec.r_multiple,
        rec.reason_entry, rec.reason_exit, rec.score, rec.held_sec, rec.equity_after, rec.closed_at, rec.strategy],
    });
  }

  stats() {
    const n = this.closed.length;
    if (!n) return { trades: 0, equity: +this.equity.toFixed(2), openPositions: this.positions.size };
    const wins = this.closed.filter(c => c.pnl > 0);
    const grossWin = wins.reduce((a, c) => a + c.pnl, 0);
    const grossLoss = -this.closed.filter(c => c.pnl <= 0).reduce((a, c) => a + c.pnl, 0);
    return {
      trades: n,
      winRate: +(wins.length / n * 100).toFixed(1),
      avgR: +(this.closed.reduce((a, c) => a + c.r_multiple, 0) / n).toFixed(2),
      profitFactor: grossLoss ? +(grossWin / grossLoss).toFixed(2) : Infinity,
      realizedPnl: +this.realizedPnl.toFixed(2),
      equity: +this.equity.toFixed(2),
      returnPct: +((this.equity / C.START_EQUITY - 1) * 100).toFixed(2),
      openPositions: this.positions.size,
    };
  }
}

module.exports = { PaperBroker };
