const express = require('express');
const https = require('https');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

function bybitGet(endpoint) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://api.bybit.com${endpoint}`,
      { headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Origin': 'https://www.bybit.com',
          'Referer': 'https://www.bybit.com/',
        } },
      res => {
        let raw = '';
        res.on('data', d => (raw += d));
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); }
          catch (e) { reject(new Error('Parse error: ' + raw.slice(0, 80))); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

const pct = (curr, prev) =>
  prev && prev !== 0 ? ((curr - prev) / Math.abs(prev)) * 100 : null;

const sum = arr => arr.reduce((a, b) => a + b, 0);

// ── OI Snapshot system ────────────────────────────────────────────────────
// Stores openInterestValue (USD) per symbol every 60s.
// Gives exact time-ago lookups instead of relying on 5min candle boundaries.
const oiSnaps = new Map(); // symbol → [{ts, oiUSD}, ...] newest first, max 1500

async function pollSnapshots() {
  try {
    const res = await bybitGet('/v5/market/tickers?category=linear');
    const now = Date.now();
    for (const t of res.result.list) {
      if (!t.symbol.endsWith('USDT')) continue;
      const oiUSD = parseFloat(t.openInterestValue);
      if (!oiSnaps.has(t.symbol)) oiSnaps.set(t.symbol, []);
      const arr = oiSnaps.get(t.symbol);
      arr.unshift({ ts: now, oiUSD });
      if (arr.length > 1500) arr.length = 1500;
    }
  } catch (e) {
    console.error('snapshot poll error:', e.message);
  }
}

function snapAt(symbol, msAgo) {
  const arr = oiSnaps.get(symbol);
  if (!arr?.length) return null;
  const target = Date.now() - msAgo;
  const best = arr.reduce((b, s) =>
    Math.abs(s.ts - target) < Math.abs(b.ts - target) ? s : b
  );
  // If closest snapshot is >90s from target, it's not useful — use candle fallback
  if (Math.abs(best.ts - target) > 90_000) return null;
  return best.oiUSD;
}

pollSnapshots();
setInterval(pollSnapshots, 60_000);

// ── Per-symbol data fetch ─────────────────────────────────────────────────
async function fetchSymbolData(symbol, currentOIusd, currentPrice) {
  const [oiRes, k1hRes, k5mRes] = await Promise.all([
    bybitGet(`/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=5min&limit=290`),
    bybitGet(`/v5/market/kline?category=linear&symbol=${symbol}&interval=60&limit=50`),
    bybitGet(`/v5/market/kline?category=linear&symbol=${symbol}&interval=5&limit=4`),
  ]);

  const oiList = oiRes.result?.list;
  const k1h = k1hRes.result?.list;
  const k5m = k5mRes.result?.list;

  if (!oiList?.length || !k1h?.length || !k5m?.length) return null;

  // OI in USD: use own 1-min snapshots for precision.
  // Fallback: history candles (base currency) × current price ≈ USD value.
  const currUSD = currentOIusd;
  const oi_usd  = oiList.map(x => parseFloat(x.openInterest) * currentPrice);

  const oi5m  = pct(currUSD, snapAt(symbol,       5 * 60_000) ?? oi_usd[1]);
  const oi15m = pct(currUSD, snapAt(symbol,      15 * 60_000) ?? oi_usd[3]);
  const oi1h  = pct(currUSD, snapAt(symbol,      60 * 60_000) ?? oi_usd[12]);
  const oi4h  = pct(currUSD, snapAt(symbol,  4 * 60 * 60_000) ?? oi_usd[48]);
  const oi24h = pct(currUSD, snapAt(symbol, 24 * 60 * 60_000) ?? oi_usd[288]);

  // 1h klines descending: [0]=in-progress, [1]=last complete
  // [startTime, open, high, low, close, volume, turnover]
  const vol1h = k1h.map(k => parseFloat(k[6])); // USDT turnover
  const cls1h = k1h.map(k => parseFloat(k[4])); // close

  const vol1hPct  = k1h.length > 2  ? pct(vol1h[1], vol1h[2]) : null;
  const vol12hPct = k1h.length > 24 ? pct(sum(vol1h.slice(1, 13)), sum(vol1h.slice(13, 25))) : null;
  const vol24hPct = k1h.length > 48 ? pct(sum(vol1h.slice(1, 25)), sum(vol1h.slice(25, 49))) : null;

  // 5m klines descending: [0]=in-progress, [1]=last complete, [2]=prior
  const cls5m = k5m.map(k => parseFloat(k[4]));
  const price5mPct = k5m.length > 2 ? pct(cls5m[1], cls5m[2]) : null;

  const price1hPct = cls1h.length > 1 ? pct(cls1h[0], cls1h[1]) : null;
  const price4hPct = cls1h.length > 4 ? pct(cls1h[0], cls1h[4]) : null;

  return { oi5m, oi15m, oi1h, oi4h, oi24h, vol1hPct, vol12hPct, vol24hPct, price5mPct, price1hPct, price4hPct, vol1hUSD: vol1h[1] ?? 0 };
}

function inChunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

let cache = null;
let cacheAt = 0;
const TTL = 10_000;

app.get('/api/screener', async (req, res) => {
  try {
    if (cache && Date.now() - cacheAt < TTL) return res.json(cache);

    const tickRes = await bybitGet('/v5/market/tickers?category=linear');
    const tickers = tickRes.result.list
      .filter(t => t.symbol.endsWith('USDT') && parseFloat(t.turnover24h) > 500_000)
      .sort((a, b) => parseFloat(b.turnover24h) - parseFloat(a.turnover24h))
      .slice(0, 100);

    const rows = [];
    for (const batch of inChunks(tickers, 12)) {
      const settled = await Promise.allSettled(
        batch.map(async t => {
          const d = await fetchSymbolData(
            t.symbol,
            parseFloat(t.openInterestValue),
            parseFloat(t.lastPrice)
          );
          if (!d) return null;
          return {
            symbol: t.symbol.replace('USDT', ''),
            price: parseFloat(t.lastPrice),
            price24hPct: parseFloat(t.price24hPcnt) * 100,
            fundingRate: parseFloat(t.fundingRate) * 100,
            oiUSD: parseFloat(t.openInterestValue),
            ...d,
          };
        })
      );
      for (const s of settled) {
        if (s.status === 'fulfilled' && s.value) rows.push(s.value);
      }
    }

    rows.sort((a, b) => (b.oi5m ?? -Infinity) - (a.oi5m ?? -Infinity));
    rows.forEach((r, i) => { r.rank = i + 1; });

    cache = { ts: Date.now(), symbols: rows };
    cacheAt = Date.now();
    res.json(cache);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Screener → http://localhost:${PORT}`));
