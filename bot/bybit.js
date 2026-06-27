'use strict';
/**
 * bot/bybit.js
 * Cliente de datos públicos de Bybit v5 (sin claves API).
 *  - REST: klines, open interest, funding history, tickers.
 *  - WS  : publicTrade (CVD) y allLiquidation (cascadas).
 *
 * Node 18+ trae fetch global. El WS usa el paquete 'ws' (npm i ws).
 */
const C = require('./config');
let WebSocket;
try { WebSocket = require('ws'); } catch (_) { WebSocket = null; }

async function get(path) {
  const res = await fetch(C.REST + path, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (j.retCode !== 0) throw new Error(`Bybit ${j.retCode}: ${j.retMsg}`);
  return j.result;
}

async function klines(symbol) {
  const r = await get(`/v5/market/kline?category=${C.CATEGORY}&symbol=${symbol}&interval=${C.KLINE_INTERVAL}&limit=${C.KLINE_LIMIT}`);
  const rows = r.list || [];
  return rows.slice().reverse().map(k => ({
    ts: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], turnover: +k[6],
  }));
}

async function openInterest(symbol) {
  const r = await get(`/v5/market/open-interest?category=${C.CATEGORY}&symbol=${symbol}&intervalTime=${C.OI_INTERVAL}&limit=${C.OI_LIMIT}`);
  return (r.list || [])
    .map(x => ({ ts: +x.timestamp, oi: +x.openInterest }))
    .sort((a, b) => a.ts - b.ts);
}

async function fundingHistory(symbol) {
  const r = await get(`/v5/market/funding/history?category=${C.CATEGORY}&symbol=${symbol}&limit=${C.FUNDING_LIMIT}`);
  return (r.list || []).slice().reverse().map(x => +x.fundingRate);
}

async function ticker(symbol) {
  const r = await get(`/v5/market/tickers?category=${C.CATEGORY}&symbol=${symbol}`);
  const t = (r.list || [])[0];
  if (!t) return null;
  return {
    last: +t.lastPrice,
    funding: +(t.fundingRate || 0),
    oi: +(t.openInterest || 0),
    turnover24h: +(t.turnover24h || 0),
    price24hPcnt: +(t.price24hPcnt || 0),
    indexPrice: +(t.indexPrice || 0),
    markPrice: +(t.markPrice || 0),
  };
}

async function orderbook(symbol, limit = 50) {
  const r = await get(`/v5/market/orderbook?category=${C.CATEGORY}&symbol=${symbol}&limit=${limit}`);
  return { bids: r.b || [], asks: r.a || [] }; // [[price, size], ...]
}

/** Mantiene buffers en memoria de trades (CVD) y liquidaciones por símbolo. */
class Stream {
  constructor(symbols) {
    this.symbols = symbols;
    this.trades = new Map();  // symbol -> [{ts,side,size,price}]
    this.liqs = new Map();    // symbol -> [{ts,side,notional,price}]
    this.connected = false;
    this.connectedAt = null; // ms de la última (re)conexión: los buffers solo cubren desde aquí
    this._ws = null;
    symbols.forEach(s => { this.trades.set(s, []); this.liqs.set(s, []); });
  }

  getTrades(s) { return this.trades.get(s) || []; }
  getLiqs(s) { return this.liqs.get(s) || []; }

  /**
   * Segundos de cobertura REAL de los buffers desde la última (re)conexión.
   * Tras reconectar hay un hueco sin datos: usar esto para acotar el baseline
   * del z-score de liquidaciones y para el gating de warmup.
   */
  coverageSec() {
    if (!this.connected || !this.connectedAt) return 0;
    return (Date.now() - this.connectedAt) / 1000;
  }

  _args() {
    const a = [];
    for (const s of this.symbols) { a.push(`publicTrade.${s}`); a.push(`allLiquidation.${s}`); }
    return a;
  }

  _trim(arr, cut) { while (arr.length && arr[0].ts < cut) arr.shift(); }

  start() {
    if (!WebSocket) throw new Error("Falta 'ws'. Ejecuta: npm i ws");
    const connect = () => {
      this._ws = new WebSocket(C.WS);
      this._ws.on('open', () => {
        this.connected = true;
        this.connectedAt = Date.now();
        // Bybit acepta varios topics por mensaje; troceamos por si hay muchos.
        const args = this._args();
        for (let i = 0; i < args.length; i += 10) {
          this._ws.send(JSON.stringify({ op: 'subscribe', args: args.slice(i, i + 10) }));
        }
        this._ping = setInterval(() => {
          if (this._ws.readyState === 1) this._ws.send(JSON.stringify({ op: 'ping' }));
        }, 20000);
      });
      this._ws.on('message', raw => this._onMessage(raw));
      this._ws.on('close', () => { this.connected = false; clearInterval(this._ping); setTimeout(connect, 3000); });
      this._ws.on('error', () => { this.connected = false; });
    };
    connect();
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    const topic = msg.topic || '';
    const data = msg.data;
    if (!topic || !data) return;
    const cut = Date.now() - C.LIQ_BASELINE_SEC * 1000;

    if (topic.startsWith('publicTrade.')) {
      const sym = topic.split('.')[1];
      const arr = this.trades.get(sym); if (!arr) return;
      const norm = [];
      for (const t of data) norm.push({ ts: +t.T, side: t.S, size: +t.v, price: +t.p });
      for (const t of norm) arr.push(t);
      const cutTrades = Date.now() - 600 * 1000; // mantener solo 10 minutos de trades en memoria
      this._trim(arr, cutTrades);
      if (this.onTrades) { try { this.onTrades(sym, norm); } catch (_) {} }
    } else if (topic.startsWith('allLiquidation.')) {
      const sym = topic.split('.')[1];
      const arr = this.liqs.get(sym); if (!arr) return;
      const list = Array.isArray(data) ? data : [data];
      const norm = [];
      for (const e of list) {
        const price = +e.p, size = +e.v;
        norm.push({ ts: +e.T, side: e.S, notional: price * size, price });
      }
      for (const l of norm) arr.push(l);
      this._trim(arr, cut);
      if (this.onLiqs) { try { this.onLiqs(sym, norm); } catch (_) {} }
    }
  }

  stop() { try { this._ws && this._ws.close(); } catch (_) {} }
}

module.exports = { klines, openInterest, fundingHistory, ticker, orderbook, Stream };
