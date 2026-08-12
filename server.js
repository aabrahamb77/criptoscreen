require('dotenv').config();
const express = require('express');
const compression = require('compression');
const path = require('path');
const db = require('./db');
const ai = require('./ai');

const app = express();
// gzip en TODAS las respuestas (HTML/JS/CSS/JSON). El index.html (~200 KB) y el
// JSON de /api/sync bajan ~5-10x → clave para no reventar el ancho de banda
// del plan gratis de Render.
app.use(compression());
app.use(express.json({ limit: '10mb' }));
// Cache en el navegador: el HTML revalida (304 si no cambió, casi 0 bytes) y los
// assets (js/css/img) se cachean 1h para no re-descargarse en cada navegación.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', filePath.endsWith('.html') ? 'no-cache' : 'public, max-age=3600');
  },
}));

// Auth opcional: si defines API_TOKEN en .env, los endpoints /api/* exigen
// "Authorization: Bearer <token>". Sin API_TOKEN no cambia nada (uso local).
// Útil solo si expones el server fuera de localhost.
const API_TOKEN = process.env.API_TOKEN;
app.use('/api', (req, res, next) => {
  if (!API_TOKEN) return next();
  if ((req.headers.authorization || '') === `Bearer ${API_TOKEN}`) return next();
  res.status(401).json({ error: 'no autorizado' });
});

// Rate limit simple en memoria (sin dependencias): max peticiones por IP/ventana.
const _hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const arr = (_hits.get(req.ip) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'demasiadas peticiones, espera un momento' });
    arr.push(now);
    _hits.set(req.ip, arr);
    next();
  };
}

// ── Snapshots de precio cada 5 min ──────────────────────────────────────────
// Guarda un snapshot de precio/OI de los ~150 pares más líquidos aunque no haya
// ninguna pestaña abierta. Con esto el frontend puede resolver señales viejas
// (+30m/+1h) con el precio CORRECTO de ese momento y hacer backfill del
// seguimiento. Con Turso configurado persiste 14 días; sin Turso, ring buffer
// en memoria (48h, se pierde al reiniciar el server).
// Nota: si Bybit bloquea la IP del servidor (algunos clouds), el job falla en
// silencio y todo lo demás sigue funcionando igual que antes.
const SNAP_INTERVAL_MS  = 5 * 60_000;
const SNAP_RETENTION_MS = 14 * 24 * 3600_000;
const memSnaps = []; // fallback en memoria: [{ ts, rows: [{symbol, price, oi}] }]
let _snapErrLoggedAt = 0;

async function captureSnapshot() {
  try {
    const res = await fetch('https://api.bybit.com/v5/market/tickers?category=linear', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const ts = Date.now();
    const rows = (json.result?.list || [])
      .filter(t => t.symbol.endsWith('USDT') && parseFloat(t.turnover24h) > 500_000)
      .sort((a, b) => parseFloat(b.turnover24h) - parseFloat(a.turnover24h))
      .slice(0, 150)
      .map(t => ({
        symbol: t.symbol.replace('USDT', ''),
        price: parseFloat(t.lastPrice),
        oi: parseFloat(t.openInterestValue) || null,
      }))
      .filter(r => Number.isFinite(r.price) && r.price > 0);
    if (!rows.length) return;
    if (db.enabled()) {
      await db.savePriceSnaps(ts, rows);
    } else {
      memSnaps.push({ ts, rows });
      const cut = ts - 48 * 3600_000;
      while (memSnaps.length && memSnaps[0].ts < cut) memSnaps.shift();
    }
  } catch (err) {
    if (Date.now() - _snapErrLoggedAt > 3600_000) {
      console.error('snapshot job (no crítico):', err.message);
      _snapErrLoggedAt = Date.now();
    }
  }
}
setInterval(captureSnapshot, SNAP_INTERVAL_MS);
captureSnapshot();
if (db.enabled()) {
  setInterval(() => db.prunePriceSnaps(Date.now() - SNAP_RETENTION_MS).catch(() => {}), 3600_000);
}

function memPriceAt(symbol, ts, tolMs) {
  let best = null, bestDist = Infinity;
  for (const snap of memSnaps) {
    const dist = Math.abs(snap.ts - ts);
    if (dist > tolMs || dist >= bestDist) continue;
    const r = snap.rows.find(x => x.symbol === symbol);
    if (r) { best = { symbol, ts: snap.ts, price: r.price }; bestDist = dist; }
  }
  return best;
}

function memSeries(symbols, from) {
  const set = new Set(symbols);
  const out = [];
  for (const snap of memSnaps) {
    if (snap.ts < from) continue;
    for (const r of snap.rows) if (set.has(r.symbol)) out.push({ ts: snap.ts, symbol: r.symbol, price: r.price });
  }
  return out;
}

// Lookup puntual: [{symbol, ts}] → precio más cercano dentro de ±tolMs (o null)
app.post('/api/prices/lookup', rateLimit(30, 60_000), async (req, res) => {
  const queries = Array.isArray(req.body?.queries) ? req.body.queries.slice(0, 200) : [];
  const tolMs = Math.min(Math.max(+req.body?.tolMs || 5 * 60_000, 60_000), 15 * 60_000);
  const results = [];
  for (const q of queries) {
    if (!q || !q.symbol || !q.ts) { results.push(null); continue; }
    let hit = null;
    try {
      hit = db.enabled()
        ? await db.priceAt(String(q.symbol), +q.ts, tolMs)
        : memPriceAt(String(q.symbol), +q.ts, tolMs);
    } catch (_) { /* sin datos */ }
    results.push(hit);
  }
  res.json({ results });
});

// Serie desde `from` para varios símbolos (backfill del seguimiento)
app.get('/api/prices/series', rateLimit(20, 60_000), async (req, res) => {
  const symbols = String(req.query.symbols || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 60);
  const from = +req.query.from || Date.now() - 24 * 3600_000;
  if (!symbols.length) return res.json({ rows: [] });
  try {
    const rows = db.enabled() ? await db.priceSeries(symbols, from) : memSeries(symbols, from);
    res.json({ rows });
  } catch (err) {
    console.error('GET /api/prices/series error:', err.message);
    res.status(500).json({ error: 'series read failed' });
  }
});

// ── Proxy CoinGlass (opcional) ───────────────────────────────────────────
// Define COINGLASS_API_KEY en .env y el frontend podrá pedir cualquier endpoint
// de open-api-v4.coinglass.com vía /api/cg/<ruta>?<params> sin exponer la key.
// Caché de 60s por ruta+params para no quemar el rate limit del plan.
const CG_KEY = process.env.COINGLASS_API_KEY;
const _cgCache = new Map();
app.get('/api/cg/*', rateLimit(60, 60_000), async (req, res) => {
  if (!CG_KEY) return res.status(503).json({ error: 'CoinGlass no configurado (falta COINGLASS_API_KEY en .env)' });
  const sub = req.params[0];
  const qs = new URLSearchParams(req.query).toString();
  const cacheKey = sub + '?' + qs;
  const hit = _cgCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < 60_000) return res.json(hit.data);
  try {
    const r = await fetch(`https://open-api-v4.coinglass.com/api/${sub}${qs ? '?' + qs : ''}`, {
      headers: { 'CG-API-KEY': CG_KEY, accept: 'application/json' },
    });
    const data = await r.json();
    _cgCache.set(cacheKey, { ts: Date.now(), data });
    if (_cgCache.size > 300) _cgCache.delete(_cgCache.keys().next().value);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'cg proxy: ' + err.message });
  }
});

// ── Proxy de order book (Binance/OKX) ───────────────────────────────────────
// Solo lectura pública (sin API key, sin autenticación). Se proxea desde el
// server para no depender de que esos exchanges habiliten CORS en el navegador
// — mismo patrón que /api/cg. Usado para combinar los muros de compra/venta
// de los 3 exchanges más grandes (Bybit se pide directo desde el navegador,
// como siempre; este proxy cubre Binance y OKX).
const _exchCache = new Map();
const EXCH_URLS = {
  binance: (symbol, limit) => `https://fapi.binance.com/fapi/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=${limit}`,
  okx:     (symbol, limit) => `https://www.okx.com/api/v5/market/books?instId=${encodeURIComponent(symbol)}&sz=${limit}`,
};
app.get('/api/exch/depth', rateLimit(60, 60_000), async (req, res) => {
  const exchange = String(req.query.exchange || '');
  const symbol = String(req.query.symbol || '');
  const limit = Math.min(Math.max(+req.query.limit || 200, 5), 500);
  const build = EXCH_URLS[exchange];
  if (!build || !symbol) return res.status(400).json({ error: 'exchange/symbol inválido' });
  const cacheKey = `${exchange}:${symbol}:${limit}`;
  const hit = _exchCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < 10_000) return res.json(hit.data);
  try {
    const r = await fetch(build(symbol, limit), { headers: { Accept: 'application/json' } });
    const raw = await r.json();
    // Normalizar y RECORTAR a solo [precio, tamaño]: ~40-60% menos bytes de
    // egress (importa en Render, que da 5GB/mes de ancho de banda)
    let data = raw;
    if (exchange === 'binance') {
      data = { bids: (raw.bids || []).map(l => [l[0], l[1]]), asks: (raw.asks || []).map(l => [l[0], l[1]]) };
    } else if (exchange === 'okx') {
      const d0 = raw.data?.[0] || {};
      data = { bids: (d0.bids || []).map(l => [l[0], l[1]]), asks: (d0.asks || []).map(l => [l[0], l[1]]) };
    }
    _exchCache.set(cacheKey, { ts: Date.now(), data });
    if (_exchCache.size > 50) _exchCache.delete(_exchCache.keys().next().value);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'exch proxy: ' + err.message });
  }
});

// ── Proxy de respaldo a Bybit (solo lectura /v5/market/*) ───────────────────
// El navegador llama a Bybit directo; si su red/extensión/WAF lo bloquea
// ("Failed to fetch"), el frontend reintenta por aquí automáticamente.
app.get('/api/exch/bybit', rateLimit(3000, 60_000), async (req, res) => {
  const path = String(req.query.path || '');
  if (!path.startsWith('/v5/market/')) return res.status(400).json({ error: 'solo se permite /v5/market/*' });
  try {
    const r = await fetch('https://api.bybit.com' + path, { headers: { Accept: 'application/json' } });
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'bybit proxy: ' + err.message });
  }
});

// ── Datos públicos GRATUITOS (sin API key) para el panel ₿ BTC ──────────────
// Respaldo cuando el plan de CoinGlass no incluye esos módulos.

// Top traders de Binance Futures: % de posiciones long de las cuentas top
app.get('/api/exch/top-ls', rateLimit(30, 60_000), async (req, res) => {
  const hit = _exchCache.get('top-ls');
  if (hit && Date.now() - hit.ts < 5 * 60_000) return res.json(hit.data);
  try {
    const r = await fetch('https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=BTCUSDT&period=1h&limit=8', {
      headers: { Accept: 'application/json' },
    });
    const data = await r.json();
    _exchCache.set('top-ls', { ts: Date.now(), data });
    res.json(data);
  } catch (err) { res.status(502).json({ error: 'top-ls: ' + err.message }); }
});

// Premium Coinbase vs Binance: precios spot públicos de ambos
app.get('/api/exch/premium', rateLimit(60, 60_000), async (req, res) => {
  const hit = _exchCache.get('premium');
  if (hit && Date.now() - hit.ts < 30_000) return res.json(hit.data);
  try {
    const [cb, bn] = await Promise.all([
      fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot', { headers: { Accept: 'application/json' } }).then(r => r.json()),
      fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', { headers: { Accept: 'application/json' } }).then(r => r.json()),
    ]);
    const data = { coinbase: parseFloat(cb?.data?.amount), binance: parseFloat(bn?.price) };
    _exchCache.set('premium', { ts: Date.now(), data });
    res.json(data);
  } catch (err) { res.status(502).json({ error: 'premium: ' + err.message }); }
});

// Respaldo en servidor de trackHistory + stratSignals (Turso). Si no está
// configurado, responde 204/{} para que el frontend siga usando solo localStorage.
app.get('/api/sync', async (req, res) => {
  if (!db.enabled()) return res.json(null);
  try {
    const data = await db.loadSync();
    res.json(data);
  } catch (err) {
    console.error('GET /api/sync error:', err.message);
    res.status(500).json({ error: 'sync read failed' });
  }
});

app.post('/api/sync', async (req, res) => {
  if (!db.enabled()) return res.status(204).end();
  try {
    const { favorites } = req.body || {};
    if (!Array.isArray(favorites)) {
      return res.status(400).json({ error: 'invalid payload' });
    }
    await db.saveSync(favorites);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/sync error:', err.message);
    res.status(500).json({ error: 'sync write failed' });
  }
});

// Explica en lenguaje natural el contexto de una moneda ya calculado en el
// frontend (heat score, confluencia, régimen, alineación, playbook, etc.).
// Si no hay ANTHROPIC_API_KEY, responde 503 y el frontend lo muestra como
// "función no configurada" sin romper nada.
app.post('/api/explain', rateLimit(10, 60_000), async (req, res) => {
  if (!ai.enabled()) return res.status(503).json({ error: 'IA no configurada (falta ANTHROPIC_API_KEY)' });
  try {
    const ctx = req.body || {};
    if (!ctx.symbol) return res.status(400).json({ error: 'falta symbol' });
    const text = await ai.explain(ctx);
    res.json({ text });
  } catch (err) {
    console.error('POST /api/explain error:', err.message);
    res.status(500).json({ error: 'explain failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Screener → http://localhost:${PORT}`));
