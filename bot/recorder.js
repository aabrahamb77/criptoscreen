'use strict';
/**
 * bot/recorder.js
 * Graba el order flow en Turso para poder BACKTESTEAR estrategias con datos
 * reales más adelante (liquidaciones y CVD no se pueden descargar de Bybit,
 * solo llegan por WebSocket — si no se graban, se pierden).
 *
 *  - flow_cvd  : trades agregados por buckets (FLOW_BUCKET_SEC, 15s por defecto):
 *                buy_vol / sell_vol / nº trades / last / high / low.
 *  - flow_liqs : liquidaciones RAW (son poco frecuentes, se guardan tal cual).
 *
 * Activación: LXR_RECORD=1 (+ TURSO_DATABASE_URL / TURSO_AUTH_TOKEN).
 * Retención: FLOW_RETENTION_DAYS (14 por defecto), se poda cada 6h.
 * Volumen aproximado: con 10 símbolos y buckets de 15s ≈ 58k filas/día.
 */
const BUCKET_SEC     = Number(process.env.FLOW_BUCKET_SEC || 15);
const RETENTION_DAYS = Number(process.env.FLOW_RETENTION_DAYS || 14);
const FLUSH_SEC      = 30;

let client = null;
try {
  const { createClient } = require('@libsql/client');
  if (process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) {
    client = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  }
} catch (_) { /* libsql no disponible */ }

let _init = null;
function ensureTables() {
  if (!client) return Promise.resolve(false);
  if (!_init) {
    _init = client.batch([
      `CREATE TABLE IF NOT EXISTS flow_cvd (
         symbol TEXT NOT NULL, bucket_ts INTEGER NOT NULL,
         buy_vol REAL NOT NULL DEFAULT 0, sell_vol REAL NOT NULL DEFAULT 0,
         trades INTEGER NOT NULL DEFAULT 0,
         last_price REAL, high REAL, low REAL,
         PRIMARY KEY (symbol, bucket_ts))`,
      `CREATE TABLE IF NOT EXISTS flow_liqs (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         ts INTEGER NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL,
         price REAL, notional REAL)`,
      `CREATE INDEX IF NOT EXISTS idx_flow_liqs_sym_ts ON flow_liqs(symbol, ts)`,
    ], 'write').then(() => true).catch(e => { console.error('recorder init:', e.message); return false; });
  }
  return _init;
}

class FlowRecorder {
  constructor() {
    this.buckets = new Map();   // `${sym}|${bucketTs}` → agregado en curso
    this.liqQueue = [];
    this._timer = null;
    this._pruneTimer = null;
    this.enabled = !!client;
    this.written = { cvd: 0, liqs: 0 };
  }

  /** Engancha los hooks del Stream y arranca el flush periódico. */
  attach(stream) {
    if (!this.enabled) {
      console.log('Recorder: Turso no configurado — grabación de order flow desactivada.');
      return false;
    }
    stream.onTrades = (sym, trades) => this._addTrades(sym, trades);
    stream.onLiqs   = (sym, liqs)   => this._addLiqs(sym, liqs);
    this._timer = setInterval(() => this.flush().catch(e => console.error('recorder flush:', e.message)), FLUSH_SEC * 1000);
    this._pruneTimer = setInterval(() => this.prune().catch(() => {}), 6 * 3600_000);
    this.prune().catch(() => {});
    console.log(`Recorder: grabando CVD (buckets ${BUCKET_SEC}s) y liquidaciones en Turso (retención ${RETENTION_DAYS}d).`);
    return true;
  }

  _addTrades(sym, trades) {
    const bucketMs = BUCKET_SEC * 1000;
    for (const t of trades) {
      const bucketTs = Math.floor(t.ts / bucketMs) * bucketMs;
      const key = sym + '|' + bucketTs;
      let b = this.buckets.get(key);
      if (!b) {
        b = { symbol: sym, bucketTs, buy: 0, sell: 0, n: 0, last: t.price, hi: t.price, lo: t.price };
        this.buckets.set(key, b);
      }
      if (t.side === 'Buy') b.buy += t.size; else b.sell += t.size;
      b.n++; b.last = t.price;
      if (t.price > b.hi) b.hi = t.price;
      if (t.price < b.lo) b.lo = t.price;
    }
  }

  _addLiqs(sym, liqs) {
    for (const l of liqs) this.liqQueue.push({ ts: l.ts, symbol: sym, side: l.side, price: l.price, notional: l.notional });
  }

  /** Escribe en Turso los buckets ya CERRADOS y la cola de liquidaciones. */
  async flush() {
    if (!(await ensureTables())) return;
    const bucketMs = BUCKET_SEC * 1000;
    const openBucket = Math.floor(Date.now() / bucketMs) * bucketMs; // el actual sigue abierto
    const stmts = [];
    let cvdN = 0;
    for (const [key, b] of this.buckets) {
      if (b.bucketTs >= openBucket) continue;
      stmts.push({
        sql: `INSERT INTO flow_cvd (symbol,bucket_ts,buy_vol,sell_vol,trades,last_price,high,low)
              VALUES (?,?,?,?,?,?,?,?)
              ON CONFLICT(symbol,bucket_ts) DO UPDATE SET
                buy_vol = buy_vol + excluded.buy_vol,
                sell_vol = sell_vol + excluded.sell_vol,
                trades = trades + excluded.trades,
                last_price = excluded.last_price,
                high = MAX(high, excluded.high),
                low  = MIN(low,  excluded.low)`,
        args: [b.symbol, b.bucketTs, b.buy, b.sell, b.n, b.last, b.hi, b.lo],
      });
      this.buckets.delete(key);
      cvdN++;
    }
    const liqs = this.liqQueue.splice(0);
    for (const l of liqs) {
      stmts.push({ sql: 'INSERT INTO flow_liqs (ts,symbol,side,price,notional) VALUES (?,?,?,?,?)',
        args: [l.ts, l.symbol, l.side, l.price, l.notional] });
    }
    for (let i = 0; i < stmts.length; i += 50) {
      await client.batch(stmts.slice(i, i + 50), 'write');
    }
    this.written.cvd += cvdN;
    this.written.liqs += liqs.length;
  }

  /** Borra datos más antiguos que la retención configurada. */
  async prune() {
    if (!(await ensureTables())) return;
    const cut = Date.now() - RETENTION_DAYS * 86_400_000;
    await client.execute({ sql: 'DELETE FROM flow_cvd WHERE bucket_ts < ?', args: [cut] });
    await client.execute({ sql: 'DELETE FROM flow_liqs WHERE ts < ?', args: [cut] });
  }

  stats() {
    return { enabled: this.enabled, bucketSec: BUCKET_SEC, retentionDays: RETENTION_DAYS,
      pendingBuckets: this.buckets.size, pendingLiqs: this.liqQueue.length, written: this.written };
  }
}

module.exports = { FlowRecorder };
