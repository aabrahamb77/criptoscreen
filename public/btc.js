/* public/btc.js
 * ₿ BTC — Sistema de DIRECCIONALIDAD por confluencia.
 *
 * Cada factor vota entre −1 y +1 y tiene un peso; la suma ponderada da un
 * sesgo −100..+100 → probabilidad direccional, SIEMPRE con el porqué en texto.
 *
 * Factores (todos con datos gratuitos de Bybit):
 *  1. Flujo de dinero (25): OI multi-ventana + precio + CVD + funding
 *  2. Long/Short ratio (15): cuentas long vs short (lectura contrarian del retail)
 *  3. Barridos de liquidez (15): mecha que caza stops bajo un mínimo y recupera
 *  4. Liquidez pendiente / imanes (15): equal highs/lows sin barrer = pools de stops
 *  5. Muros de order book (10): clusters de bids/asks ≥12× la mediana en ±3%
 *  6. Max pain de opciones (10): strike que minimiza el pago del vencimiento cercano
 *  7. Basis perp-spot (10): premium = sobrecalentado, descuento = miedo
 *
 * Sesiones: Asia 00:00 · Londres 08:00 · Nueva York 13:30 (UTC). Al abrir cada
 * sesión se guarda un snapshot del sesgo para comparar contra lo que pasó.
 */

const BTC_SESSIONS = [
  { key: 'Asia',       utcH: 0,  utcM: 0  },
  { key: 'Londres',    utcH: 8,  utcM: 0  },
  { key: 'Nueva York', utcH: 13, utcM: 30 },
];

const BTC = {
  ob: null,      // { bidWalls, askWalls, bidUSD, askUSD, mid, ts }
  ls: null,      // { buyRatio, prevBuyRatio, ts }
  mp: null,      // { price, expiry, expiryTs, ts }
  spot: null,    // { price, basisPct, ts }
  liq: null,     // { pools, sweeps } — calculado de k15
  factors: [],
  bias: 0, prob: 50, dir: 'NEUTRAL',
  lastDir: null,
  cg: { ts: 0, top: null, mp: null, clusters: null, err: {} }, // CoinGlass (vía /api/cg)
};

// ── Fetchers (cadencias propias, solo BTC = coste mínimo) ───────────────────

// Order book COMBINADO de los 3 exchanges más grandes (Bybit directo desde el
// navegador + Binance/OKX vía /api/exch/depth, proxeado por el server para
// evitar CORS). Los muros se buscan sobre la profundidad SUMADA, no solo la
// de Bybit — un muro que solo existe en un exchange pequeño ya no cuela.
async function btcFetchOB() {
  BTC.ob = { ...(BTC.ob || {}), ts: Date.now() }; // marca throttle aunque falle
  try {
    const [byRes, bnRes, okRes] = await Promise.all([
      bybitGet('/v5/market/orderbook?category=linear&symbol=BTCUSDT&limit=500').catch(() => null),
      fetch('/api/exch/depth?exchange=binance&symbol=BTCUSDT&limit=500').then(r => r.json()).catch(() => null),
      fetch('/api/exch/depth?exchange=okx&symbol=BTC-USDT-SWAP&limit=400').then(r => r.json()).catch(() => null),
    ]);

    const byBids = (byRes?.result?.b || []).map(([p, s]) => [+p, +s]);
    const byAsks = (byRes?.result?.a || []).map(([p, s]) => [+p, +s]);
    const bnBids = (bnRes?.bids || []).map(([p, s]) => [+p, +s]);
    const bnAsks = (bnRes?.asks || []).map(([p, s]) => [+p, +s]);
    const okBids = (okRes?.data?.[0]?.bids || []).map(([p, s]) => [+p, +s]);
    const okAsks = (okRes?.data?.[0]?.asks || []).map(([p, s]) => [+p, +s]);
    const exch = { bybit: !!byBids.length, binance: !!bnBids.length, okx: !!okBids.length };

    const allBids = [...byBids, ...bnBids, ...okBids];
    const allAsks = [...byAsks, ...bnAsks, ...okAsks];
    if (!allBids.length || !allAsks.length) return;
    const mid = (allBids[0][0] + allAsks[0][0]) / 2; // aprox: mejor bid/ask combinado

    // Agrupa niveles casi idénticos ENTRE exchanges (cada uno cotiza a un tick
    // ligeramente distinto) antes de buscar muros, para que el tamaño se sume de verdad.
    const bucketed = levels => {
      const bucket = mid * 0.0004; // ~0.04%
      const map = new Map();
      for (const [p, s] of levels) {
        const b = Math.round(p / bucket) * bucket;
        map.set(b, (map.get(b) || 0) + s);
      }
      return [...map.entries()];
    };
    const inRange = lv => Math.abs(lv[0] - mid) / mid <= 0.03; // ±3%
    const detect = side => {
      const lvls = bucketed(side).filter(inRange);
      if (lvls.length < 10) return { walls: [], usd: 0 };
      const sizes = lvls.map(l => l[1]).sort((a, b) => a - b);
      const median = sizes[Math.floor(sizes.length / 2)] || 1;
      let walls = lvls.filter(l => l[1] >= median * 12)
        .map(l => ({ price: l[0], usd: l[0] * l[1] }));
      // agrupar muros a <0.1% de distancia
      walls.sort((a, b) => a.price - b.price);
      const merged = [];
      for (const w of walls) {
        const last = merged[merged.length - 1];
        if (last && Math.abs(w.price - last.price) / mid < 0.001) { last.usd += w.usd; }
        else merged.push({ ...w });
      }
      merged.sort((a, b) => b.usd - a.usd);
      return { walls: merged.slice(0, 4), usd: lvls.reduce((a, l) => a + l[0] * l[1], 0) };
    };
    const B = detect(allBids), A = detect(allAsks);
    BTC.ob = { bidWalls: B.walls, askWalls: A.walls, bidUSD: B.usd, askUSD: A.usd, mid, exch, ts: Date.now() };
  } catch (err) { console.error('btcFetchOB falló:', err); }
}

async function btcFetchLS() {
  BTC.ls = { ...(BTC.ls || {}), ts: Date.now() };
  try {
    const r = await bybitGet('/v5/market/account-ratio?category=linear&symbol=BTCUSDT&period=15min&limit=16');
    const list = r.result?.list || [];
    if (!list.length) return;
    // list[0] = más reciente
    const cur = parseFloat(list[0].buyRatio);
    const prev = list.length > 4 ? parseFloat(list[4].buyRatio) : cur; // hace 1h
    if (Number.isFinite(cur)) BTC.ls = { buyRatio: cur, prevBuyRatio: prev, ts: Date.now() };
  } catch (_) {}
}

async function btcFetchOptions() {
  BTC.mp = { ...(BTC.mp || {}), ts: Date.now() };
  try {
    const r = await bybitGet('/v5/market/tickers?category=option&baseCoin=BTC');
    const list = r.result?.list || [];
    const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
    const byExp = new Map();
    for (const t of list) {
      const parts = t.symbol.split('-'); // BTC-27JUN25-65000-C
      if (parts.length < 4) continue;
      const oi = parseFloat(t.openInterest || 0);
      if (!oi) continue;
      if (!byExp.has(parts[1])) byExp.set(parts[1], []);
      byExp.get(parts[1]).push({ strike: +parts[2], type: parts[3], oi });
    }
    const parseExp = e => {
      const day = parseInt(e); const mon = MON[e.replace(/[0-9]/g, '').toUpperCase()];
      const yr = 2000 + parseInt(e.slice(-2));
      return (mon == null || !day || !yr) ? NaN : Date.UTC(yr, mon, day, 8);
    };
    const exps = [...byExp.keys()].map(e => ({ e, ts: parseExp(e) }))
      .filter(x => Number.isFinite(x.ts) && x.ts > Date.now())
      .sort((a, b) => a.ts - b.ts);
    if (!exps.length) return;
    const chain = byExp.get(exps[0].e);
    const strikes = [...new Set(chain.map(c => c.strike))].sort((a, b) => a - b);
    let best = null;
    for (const K of strikes) {
      let pay = 0;
      for (const c of chain) {
        pay += c.type === 'C' ? c.oi * Math.max(0, K - c.strike) : c.oi * Math.max(0, c.strike - K);
      }
      if (!best || pay < best.pay) best = { pay, K };
    }
    BTC.mp = { price: best.K, expiry: exps[0].e, expiryTs: exps[0].ts, ts: Date.now() };
  } catch (_) {}
}

async function btcFetchSpot() {
  BTC.spot = { ...(BTC.spot || {}), ts: Date.now() };
  try {
    const r = await bybitGet('/v5/market/tickers?category=spot&symbol=BTCUSDT');
    const p = parseFloat(r.result?.list?.[0]?.lastPrice);
    const row = allRows.find(x => x.symbol === 'BTC');
    if (Number.isFinite(p) && row?.price) {
      BTC.spot = { price: p, basisPct: (row.price - p) / p * 100, ts: Date.now() };
    }
  } catch (_) {}
}

// ── CoinGlass (vía proxy /api/cg — requiere COINGLASS_API_KEY en .env) ──────
async function btcFetchCG() {
  BTC.cg.ts = Date.now();
  const get = async path => {
    try {
      const r = await fetch('/api/cg/' + path);
      if (r.status === 503) return { err: 'sin API key en .env' };
      if (!r.ok) return { err: 'HTTP ' + r.status };
      const j = await r.json();
      if (j.code !== '0' && j.code !== 0) return { err: j.msg || 'no incluido en tu plan' };
      return { data: j.data };
    } catch (_) { return { err: 'sin conexión' }; }
  };

  // 1) Top traders de Binance (posiciones, 4h) — disponible en TODOS los planes
  const top = await get('futures/top-long-short-position-ratio/history?exchange=Binance&symbol=BTCUSDT&interval=4h&limit=8');
  if (Array.isArray(top.data) && top.data.length) {
    const arr = top.data;
    const last = arr[arr.length - 1];
    const prev = arr.length > 2 ? arr[arr.length - 3] : last;
    BTC.cg.top = { longPct: +last.top_position_long_percent, prev: +prev.top_position_long_percent };
    BTC.cg.err.top = null;
  } else { BTC.cg.top = null; BTC.cg.err.top = top.err || 'sin datos'; }

  // 2) Max pain de Deribit (mercado dominante de opciones) — todos los planes
  const mp = await get('option/max-pain?symbol=BTC&exchange=Deribit');
  if (Array.isArray(mp.data) && mp.data.length) {
    const parse = d => { const s = String(d); return Date.UTC(2000 + +s.slice(0, 2), +s.slice(2, 4) - 1, +s.slice(4, 6), 8); };
    const rows = mp.data.map(x => ({ ...x, ts: parse(x.date) }))
      .filter(x => Number.isFinite(x.ts) && x.ts > Date.now() - 8 * 3600_000)
      .sort((a, b) => a.ts - b.ts);
    if (rows.length) {
      const r0 = rows[0];
      BTC.cg.mp = {
        price: +r0.max_pain_price, expiry: String(r0.date), expiryTs: r0.ts,
        pcr: r0.call_open_interest_notional ? r0.put_open_interest_notional / r0.call_open_interest_notional : null,
      };
      BTC.cg.err.mp = null;
    }
  } else { BTC.cg.mp = null; BTC.cg.err.mp = mp.err || 'sin datos'; }

  // 3) Heatmap de liquidaciones agregado (solo plan Professional+)
  const hm = await get('futures/liquidation/aggregated-heatmap/model2?symbol=BTC&range=24h');
  if (hm.data?.y_axis && hm.data?.liquidation_leverage_data) {
    const y = hm.data.y_axis;
    const cells = hm.data.liquidation_leverage_data;
    const maxX = cells.reduce((m, c) => Math.max(m, c[0]), 0);
    const byY = new Map();
    for (const [x, yi, usd] of cells) {
      if (x < maxX - 2) continue; // solo las columnas más recientes = liquidez AÚN pendiente
      byY.set(yi, (byY.get(yi) || 0) + usd);
    }
    const price = allRows.find(r => r.symbol === 'BTC')?.price;
    let above = null, below = null;
    for (const [yi, usd] of byY) {
      const lvl = y[yi];
      if (lvl == null || !price) continue;
      if (lvl > price && (!above || usd > above.usd)) above = { level: lvl, usd };
      if (lvl < price && (!below || usd > below.usd)) below = { level: lvl, usd };
    }
    BTC.cg.clusters = { above, below };
    BTC.cg.err.hm = null;
  } else { BTC.cg.clusters = null; BTC.cg.err.hm = hm.err || 'sin datos'; }

  // 4) Coinbase Premium — demanda institucional americana (todos los planes, ≥4h)
  const cbp = await get('coinbase-premium-index?interval=4h&limit=12');
  if (Array.isArray(cbp.data) && cbp.data.length) {
    const arr = cbp.data;
    const last = arr[arr.length - 1];
    const prev = arr.slice(-6, -1);
    BTC.cg.cbp = {
      rate: +last.premium_rate, premium: +last.premium,
      prevAvg: prev.length ? prev.reduce((a, x) => a + (+x.premium_rate || 0), 0) / prev.length : +last.premium_rate,
    };
    BTC.cg.err.cbp = null;
  } else { BTC.cg.cbp = null; BTC.cg.err.cbp = cbp.err || 'sin datos'; }

  // 5) Flujos de ETF de Bitcoin (dato diario) — todos los planes
  const etf = await get('etf/bitcoin/flow-history');
  if (Array.isArray(etf.data) && etf.data.length) {
    const arr = etf.data.slice(-5);
    const last = arr[arr.length - 1];
    BTC.cg.etf = {
      lastFlow: +last.flow_usd,
      sum3: arr.slice(-3).reduce((a, x) => a + (+x.flow_usd || 0), 0),
      ts: +last.timestamp,
    };
    BTC.cg.err.etf = null;
  } else { BTC.cg.etf = null; BTC.cg.err.etf = etf.err || 'sin datos'; }

  // 6) Agresión spot vs perp (taker buy/sell agregado Binance+OKX+Bybit, 4h)
  const [tbF, tbS] = await Promise.all([
    get('futures/aggregated-taker-buy-sell-volume/history?exchange_list=Binance,OKX,Bybit&symbol=BTC&interval=4h&limit=4'),
    get('spot/aggregated-taker-buy-sell-volume/history?exchange_list=Binance,OKX,Bybit&symbol=BTC&interval=4h&limit=4'),
  ]);
  const takerRatio = arr => {
    if (!Array.isArray(arr) || !arr.length) return null;
    const r = arr.slice(-2); // últimas ~8h
    const b = r.reduce((a, x) => a + (+x.aggregated_buy_volume_usd || 0), 0);
    const s = r.reduce((a, x) => a + (+x.aggregated_sell_volume_usd || 0), 0);
    return b + s > 0 ? b / (b + s) : null;
  };
  const rFut = takerRatio(tbF.data), rSpot = takerRatio(tbS.data);
  if (rFut != null && rSpot != null) { BTC.cg.taker = { spot: rSpot, fut: rFut }; BTC.cg.err.taker = null; }
  else { BTC.cg.taker = null; BTC.cg.err.taker = tbF.err || tbS.err || 'sin datos'; }

  btcComputeFactors();
  if (activeTab === 'btc') renderBTC();
}

// ── Liquidez: pools (equal highs/lows sin barrer) y barridos recientes ──────
function btcLiquidity(row) {
  const k = row.k15;
  if (!k || k.c.length < 30) return null;
  const n = k.c.length, last = k.c[n - 1];
  const atr = _patAtr(k);
  if (!atr) return null;
  const piv = _patPivots(k, 2);
  const highs = piv.filter(p => p.type === 'H');
  const lows  = piv.filter(p => p.type === 'L');

  const pools = [];
  const findPools = (exts, above) => {
    for (let i = 0; i < exts.length; i++) {
      for (let j = i + 1; j < exts.length; j++) {
        if (Math.abs(exts[i].price - exts[j].price) > 0.2 * atr) continue;
        const lvl = above ? Math.max(exts[i].price, exts[j].price) : Math.min(exts[i].price, exts[j].price);
        const swept = above
          ? k.h.slice(exts[j].i + 1).some(h => h > lvl + 0.05 * atr)
          : k.l.slice(exts[j].i + 1).some(l => l < lvl - 0.05 * atr);
        if (swept) continue;
        if (above ? lvl > last : lvl < last) pools.push({ above, level: lvl });
      }
    }
  };
  findPools(highs, true);
  findPools(lows, false);
  // dedupe niveles a <0.15×ATR y quedarse con los 2 más cercanos por lado
  const dedupe = arr => {
    arr.sort((a, b) => Math.abs(a.level - last) - Math.abs(b.level - last));
    const out = [];
    for (const p of arr) if (!out.some(o => Math.abs(o.level - p.level) < 0.15 * atr)) out.push(p);
    return out.slice(0, 2);
  };
  const poolsAbove = dedupe(pools.filter(p => p.above));
  const poolsBelow = dedupe(pools.filter(p => !p.above));

  // Barridos en las últimas 8 velas: mecha caza el pivote y el cierre recupera
  let sweptLow = null, sweptHigh = null;
  for (let i = Math.max(1, n - 8); i < n; i++) {
    for (const pl of lows) {
      if (pl.i < i - 2 && k.l[i] < pl.price - 0.05 * atr && k.c[i] > pl.price) sweptLow = { level: pl.price, barsAgo: n - 1 - i };
    }
    for (const ph of highs) {
      if (ph.i < i - 2 && k.h[i] > ph.price + 0.05 * atr && k.c[i] < ph.price) sweptHigh = { level: ph.price, barsAgo: n - 1 - i };
    }
  }
  return { poolsAbove, poolsBelow, sweptLow, sweptHigh, atr };
}

// ── Cálculo del sesgo por confluencia ───────────────────────────────────────
function btcComputeFactors() {
  const row = allRows.find(r => r.symbol === 'BTC');
  if (!row) return;
  BTC.liq = btcLiquidity(row);
  if (typeof btcComputeSMC === 'function') btcComputeSMC();
  const F = [];
  const add = (name, score, weight, reason) =>
    F.push({ name, score: Math.max(-1, Math.min(1, score)), weight, reason });
  const n = v => v ?? 0;
  const fp = fmtPrice;

  // 1) Flujo de dinero (25)
  {
    let s = 0; const why = [];
    if (n(row.oi1h) > 0.15 && n(row.price1hPct) > 0)      { s += 0.6; why.push(`OI 1h ${fmtPct(row.oi1h)} con precio subiendo = dinero nuevo LONG`); }
    else if (n(row.oi1h) > 0.15 && n(row.price1hPct) < 0) { s -= 0.6; why.push(`OI 1h ${fmtPct(row.oi1h)} con precio cayendo = dinero nuevo SHORT`); }
    else if (n(row.oi1h) < -0.15 && n(row.price1hPct) > 0){ s += 0.3; why.push(`OI cayendo con precio subiendo = cierre de cortos (squeeze)`); }
    else if (n(row.oi1h) < -0.15 && n(row.price1hPct) < 0){ s -= 0.3; why.push(`OI cayendo con precio cayendo = desapalancamiento`); }
    else why.push('OI 1h plano — sin entrada clara de dinero');
    const vol5m = n(row.vol1hUSD) / 12;
    if (row.cvd5m != null && vol5m > 0) {
      if (row.cvd5m >  vol5m * 0.08) { s += 0.3; why.push(`CVD comprador (${'+' }${fmtUSD(row.cvd5m)} en 5m)`); }
      if (row.cvd5m < -vol5m * 0.08) { s -= 0.3; why.push(`CVD vendedor (−${fmtUSD(Math.abs(row.cvd5m))} en 5m)`); }
    }
    if (n(row.fundingRate) >  0.03) { s -= 0.2; why.push(`funding alto (${row.fundingRate.toFixed(4)}%): longs sobreextendidos`); }
    if (n(row.fundingRate) < -0.01) { s += 0.2; why.push(`funding negativo: shorts pagando`); }
    add('💰 Flujo de dinero', s, 25, why.join(' · '));
  }

  // 2) Long/Short ratio (15) — lectura contrarian del retail
  if (BTC.ls?.buyRatio != null) {
    const b = BTC.ls.buyRatio;
    const s = (0.5 - b) * 5; // retail 60% long → −0.5 (combustible bajista)
    const trend = BTC.ls.prevBuyRatio != null ? b - BTC.ls.prevBuyRatio : 0;
    add('⚖️ Long/Short ratio', s, 15,
      `${(b * 100).toFixed(1)}% de cuentas en LONG${trend > 0.01 ? ' (y subiendo)' : trend < -0.01 ? ' (y bajando)' : ''} — ` +
      (b > 0.56 ? 'retail cargado de longs: sus stops abajo son combustible BAJISTA'
        : b < 0.44 ? 'retail cargado de shorts: sus stops arriba son combustible ALCISTA'
        : 'equilibrado, sin ventaja contrarian'));
  } else add('⚖️ Long/Short ratio', 0, 15, 'cargando ratio de Bybit…');

  // 2b) Top traders (CoinGlass, Binance 4h) — dinero grande: se SIGUE, no contrarian
  if (BTC.cg?.top) {
    const t = BTC.cg.top.longPct;
    const d = t - (BTC.cg.top.prev ?? t);
    add('🐋 Top traders (CG)', (t - 50) / 12, 12,
      `top traders de Binance ${t.toFixed(1)}% en LONG${Math.abs(d) >= 0.5 ? (d > 0 ? ' y aumentando' : ' y reduciendo') : ''} — el dinero grande está ${t > 52 ? 'comprado' : t < 48 ? 'vendido' : 'neutral'}`);
  } else if (BTC.cg?.err?.top) {
    add('🐋 Top traders (CG)', 0, 0, `CoinGlass no disponible: ${BTC.cg.err.top}`);
  }

  // 3) Barridos de liquidez (15)
  {
    const L = BTC.liq;
    if (L?.sweptLow && (!L.sweptHigh || L.sweptLow.barsAgo <= L.sweptHigh.barsAgo)) {
      add('🧹 Barrido de liquidez', 0.9, 15, `se barrió el mínimo de ${fp(L.sweptLow.level)} hace ${L.sweptLow.barsAgo * 15} min y RECUPERÓ — stop hunt bajista completado, típico giro ALCISTA`);
    } else if (L?.sweptHigh) {
      add('🧹 Barrido de liquidez', -0.9, 15, `se barrió el máximo de ${fp(L.sweptHigh.level)} hace ${L.sweptHigh.barsAgo * 15} min y RECHAZÓ — stop hunt alcista completado, típico giro BAJISTA`);
    } else {
      add('🧹 Barrido de liquidez', 0, 15, 'sin barridos recientes (últimas 2h) — la liquidez sigue intacta');
    }
  }

  // 3b) Estructura SMC (12) — BOS (continuación) / CHoCH (posible giro) sobre
  //     los swings confirmados de las velas 15m. CHoCH pesa más que BOS
  //     porque marca un cambio de carácter, no solo la continuación de lo ya sabido.
  {
    const smc = BTC.smc;
    const events = smc?.events;
    if (events && events.length) {
      const last = events[events.length - 1];
      const k = btcChartData();
      const barsAgo = (k?.c?.length || 0) - 1 - last.i;
      const recent = barsAgo <= 20; // ~5h a 15m
      let s = last.dir === 'up' ? 0.7 : -0.7;
      if (last.type === 'CHoCH') s *= 1.25;
      if (!recent) s *= 0.4; // rupturas viejas pesan mucho menos
      add('🧠 Estructura SMC', s, 12,
        `${last.type} ${last.dir === 'up' ? 'ALCISTA' : 'BAJISTA'} hace ${barsAgo * 15}min en ${fp(last.price)}` +
        (last.type === 'CHoCH' ? ' — cambio de carácter: la estructura previa se rompió, posible giro' : ' — continuación de la estructura vigente'));
    } else add('🧠 Estructura SMC', 0, 12, 'sin rupturas de estructura (BOS/CHoCH) claras en el historial analizado');
  }

  // 4) Liquidez pendiente / imanes (15) — heatmap REAL de CoinGlass si el plan
  //    lo incluye; si no, inferencia estructural (equal highs/lows sin barrer)
  {
    const cl = BTC.cg?.clusters;
    if (cl && (cl.above || cl.below)) {
      // atracción = tamaño del cluster / distancia (el imán gordo y cercano manda)
      const pull = c => c ? c.usd / Math.max(Math.abs(c.level - row.price) / row.price, 0.001) : 0;
      const pUp = pull(cl.above), pDn = pull(cl.below);
      const s = (pUp - pDn) / Math.max(pUp + pDn, 1) * 0.9;
      const parts = [];
      if (cl.above) parts.push(`${fmtUSD(cl.above.usd)} pendientes en ${fp(cl.above.level)} (+${((cl.above.level - row.price) / row.price * 100).toFixed(2)}%)`);
      if (cl.below) parts.push(`${fmtUSD(cl.below.usd)} en ${fp(cl.below.level)} (−${((row.price - cl.below.level) / row.price * 100).toFixed(2)}%)`);
      add('🧲 Imanes de liquidación', s, 15, `heatmap CoinGlass (24h, DATO REAL): ${parts.join(' · ')} — el imán dominante está ${pUp >= pDn ? 'ARRIBA' : 'ABAJO'}`);
    } else {
      const L = BTC.liq;
      const up = L?.poolsAbove?.[0], dn = L?.poolsBelow?.[0];
      const tag = BTC.cg?.err?.hm ? ' (heatmap CG: ' + BTC.cg.err.hm + ' — usando estructura)' : '';
      if (up && dn) {
        const dUp = (up.level - row.price) / row.price;
        const dDn = (row.price - dn.level) / row.price;
        const s = (dDn - dUp) / Math.max(dUp + dDn, 0.0001) * 0.8; // pool más cercano atrae
        add('🧲 Imanes de liquidez', s, 15,
          `pools sin barrer: arriba ${fp(up.level)} (+${(dUp * 100).toFixed(2)}%) · abajo ${fp(dn.level)} (−${(dDn * 100).toFixed(2)}%) — el imán más cercano está ${dUp < dDn ? 'ARRIBA' : 'ABAJO'}${tag}`);
      } else if (up) {
        add('🧲 Imanes de liquidez', 0.6, 15, `solo queda liquidez sin barrer ARRIBA en ${fp(up.level)} — imán alcista${tag}`);
      } else if (dn) {
        add('🧲 Imanes de liquidez', -0.6, 15, `solo queda liquidez sin barrer ABAJO en ${fp(dn.level)} — imán bajista${tag}`);
      } else {
        add('🧲 Imanes de liquidez', 0, 15, 'sin equal highs/lows claros en 24h' + tag);
      }
    }
  }

  // 5) Muros de order book (10)
  if (BTC.ob?.mid) {
    const bw = BTC.ob.bidWalls?.[0], aw = BTC.ob.askWalls?.[0];
    const imb = (BTC.ob.bidUSD - BTC.ob.askUSD) / Math.max(BTC.ob.bidUSD + BTC.ob.askUSD, 1);
    const parts = [];
    if (bw) parts.push(`muro de compra ${fmtUSD(bw.usd)} en ${fp(bw.price)} (soporte)`);
    if (aw) parts.push(`muro de venta ${fmtUSD(aw.usd)} en ${fp(aw.price)} (barrera)`);
    parts.push(`profundidad ±3%: ${imb >= 0 ? '+' : ''}${(imb * 100).toFixed(0)}% hacia ${imb >= 0 ? 'bids' : 'asks'}`);
    add('🧱 Muros order book', imb * 2, 10, parts.join(' · '));
  } else add('🧱 Muros order book', 0, 10, 'cargando order book…');

  // 6) Max pain de opciones (10) — Deribit vía CoinGlass si está disponible
  //    (mercado dominante de opciones); si no, calculado de la cadena de Bybit
  {
    const mpSrc = BTC.cg?.mp?.price ? { ...BTC.cg.mp, src: 'Deribit·CG' } : BTC.mp?.price ? { ...BTC.mp, src: 'Bybit' } : null;
    if (mpSrc) {
      const dist = (mpSrc.price - row.price) / row.price;
      const daysToExp = Math.max(0, (mpSrc.expiryTs - Date.now()) / 86_400_000);
      const wScale = daysToExp <= 1 ? 1 : daysToExp <= 3 ? 0.6 : 0.25; // pesa más cerca del vencimiento
      const pcrTxt = mpSrc.pcr != null ? ` · put/call ${mpSrc.pcr.toFixed(2)} (${mpSrc.pcr > 1 ? 'defensivo' : 'optimista'})` : '';
      add('🎯 Max pain (opciones)', Math.max(-1, Math.min(1, dist * 30)) * wScale, 10,
        `max pain ${mpSrc.src} del vencimiento ${mpSrc.expiry} en ${fp(mpSrc.price)} (${dist >= 0 ? '+' : ''}${(dist * 100).toFixed(2)}% desde aquí)` +
        (daysToExp <= 1 ? ' — vence HOY: gravedad fuerte hacia ese nivel' : ` — vence en ${daysToExp.toFixed(1)}d`) + pcrTxt);
    } else add('🎯 Max pain (opciones)', 0, 10, 'calculando con la cadena de opciones…');
  }

  // 7) Basis perp-spot (10) — premium = euforia, descuento = miedo (contrarian)
  if (BTC.spot?.basisPct != null) {
    const b = BTC.spot.basisPct;
    add('📐 Basis perp-spot', Math.max(-1, Math.min(1, -b * 12)), 10,
      `perp ${b >= 0 ? 'premium' : 'descuento'} de ${b.toFixed(3)}% vs spot — ` +
      (b > 0.04 ? 'apalancamiento long caro/eufórico (riesgo de flush)' : b < -0.02 ? 'perp con descuento: miedo, suele ser suelo' : 'neutral'));
  } else add('📐 Basis perp-spot', 0, 10, 'comparando spot vs perp…');

  // 8) Coinbase Premium (CG, peso 8) — demanda institucional americana real
  if (BTC.cg?.cbp) {
    const r = BTC.cg.cbp.rate;
    const rising  = r > BTC.cg.cbp.prevAvg + 0.005;
    const falling = r < BTC.cg.cbp.prevAvg - 0.005;
    add('🇺🇸 Coinbase Premium (CG)', Math.max(-1, Math.min(1, r * 12)), 8,
      `premium ${r >= 0 ? '+' : ''}${r.toFixed(3)}% vs Binance${rising ? ' y subiendo' : falling ? ' y bajando' : ''} — ` +
      (r > 0.03 ? 'institucionales americanos COMPRANDO spot en Coinbase' : r < -0.03 ? 'institucionales VENDIENDO en Coinbase' : 'sin presión institucional clara'));
  } else if (BTC.cg?.err?.cbp) add('🇺🇸 Coinbase Premium (CG)', 0, 0, `CoinGlass: ${BTC.cg.err.cbp}`);

  // 9) Flujos ETF (CG, peso 8) — el dato macro de BTC (actualiza a diario)
  if (BTC.cg?.etf) {
    const f = BTC.cg.etf.lastFlow, s3 = BTC.cg.etf.sum3;
    add('🏦 Flujos ETF (CG)', Math.max(-1, Math.min(1, f / 500e6 * 0.7 + s3 / 1500e6 * 0.3)), 8,
      `último día ${f >= 0 ? '+' : '−'}${fmtUSD(Math.abs(f))} · acumulado 3d ${s3 >= 0 ? '+' : '−'}${fmtUSD(Math.abs(s3))} — ` +
      (f > 100e6 ? 'los ETF están absorbiendo BTC (demanda estructural)' : f < -100e6 ? 'salidas de los ETF (presión estructural)' : 'flujo neutro'));
  } else if (BTC.cg?.err?.etf) add('🏦 Flujos ETF (CG)', 0, 0, `CoinGlass: ${BTC.cg.err.etf}`);

  // 10) Agresión spot vs perp (CG, peso 10) — las divergencias anticipan squeezes
  if (BTC.cg?.taker) {
    const { spot, fut } = BTC.cg.taker;
    let s, why;
    if (spot > 0.52 && fut < 0.48)      { s = 0.9;  why = 'SPOT comprando mientras PERPS venden — divergencia clásica de squeeze ALCISTA'; }
    else if (spot < 0.48 && fut > 0.52) { s = -0.9; why = 'PERPS comprando mientras SPOT vende — rally apalancado sin respaldo real, riesgo de flush'; }
    else if (spot > 0.52 && fut > 0.52) { s = 0.5;  why = 'compra agresiva en spot y perps a la vez — demanda amplia'; }
    else if (spot < 0.48 && fut < 0.48) { s = -0.5; why = 'venta agresiva en spot y perps a la vez — distribución amplia'; }
    else { s = (spot + fut - 1) * 3; why = 'sin dominancia clara de agresión'; }
    add('🔀 Spot vs Perp (CG)', s, 10,
      `taker buy: spot ${(spot * 100).toFixed(1)}% · perps ${(fut * 100).toFixed(1)}% (Binance+OKX+Bybit, ~8h) — ${why}`);
  } else if (BTC.cg?.err?.taker) add('🔀 Spot vs Perp (CG)', 0, 0, `CoinGlass: ${BTC.cg.err.taker}`);

  BTC.factors = F;
  // Normalizado por la suma de pesos activos: el sesgo se mantiene en −100..+100
  // aunque haya factores extra (CoinGlass) o alguno caído (peso 0 = solo informativo)
  const wSum = F.reduce((a, f) => a + f.weight, 0) || 1;
  const total = F.reduce((a, f) => a + f.score * f.weight, 0) / wSum * 100;
  BTC.bias = Math.round(total);
  BTC.prob = Math.max(5, Math.min(95, Math.round(50 + BTC.bias / 2)));
  BTC.dir  = BTC.bias >= 15 ? 'ALCISTA' : BTC.bias <= -15 ? 'BAJISTA' : 'NEUTRAL';

  // Alerta al cambiar la dirección del sesgo
  if (BTC.lastDir && BTC.dir !== 'NEUTRAL' && BTC.dir !== BTC.lastDir) {
    showToast(`₿ Sesgo BTC → ${BTC.dir} (${BTC.prob}%)`, BTC.dir === 'ALCISTA' ? 'long' : 'short');
    if (soundEnabled) beep(BTC.dir === 'ALCISTA' ? 1000 : 420, 'triangle', 250);
    notifyDesktop(`₿ BTC cambió a ${BTC.dir}`, `Probabilidad ${BTC.prob}% — abre la pestaña BTC para ver los factores`);
  }
  if (BTC.dir !== 'NEUTRAL') BTC.lastDir = BTC.dir;
}

// ── Sesiones ────────────────────────────────────────────────────────────────
function btcSessionInfo() {
  const now = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const marks = BTC_SESSIONS.map(s => ({ ...s, ts: todayUTC + (s.utcH * 60 + s.utcM) * 60_000 }));
  let current = marks[marks.length - 1]; // por defecto la última de ayer (NY)
  for (const m of marks) if (Date.now() >= m.ts) current = m;
  let next = marks.find(m => m.ts > Date.now());
  if (!next) next = { ...marks[0], ts: marks[0].ts + 86_400_000 };
  return { current, next, msToNext: next.ts - Date.now() };
}

function btcSnapshotSessions() {
  const row = allRows.find(r => r.symbol === 'BTC');
  if (!row || !BTC.factors.length) return;
  const { current } = btcSessionInfo();
  const dayKey = new Date().toISOString().slice(0, 10);
  const id = `${dayKey}|${current.key}`;
  let snaps = JSON.parse(localStorage.getItem('scalp_btc_sess') || '[]');
  if (!snaps.some(s => s.id === id)) {
    snaps.push({ id, key: current.key, ts: Date.now(), bias: BTC.bias, prob: BTC.prob, dir: BTC.dir, price: row.price });
    if (snaps.length > 12) snaps = snaps.slice(-12);
    safeSetItem('scalp_btc_sess', JSON.stringify(snaps));
  }
}

// ── Render ──────────────────────────────────────────────────────────────────
function renderBTC() {
  const el = document.getElementById('btc-tab');
  const row = allRows.find(r => r.symbol === 'BTC');
  if (!el) return;
  if (!row || !BTC.factors.length) { el.innerHTML = '<div class="lr-empty" style="padding:30px">Cargando datos de BTC…</div>'; return; }

  const { current, next, msToNext } = btcSessionInfo();
  const hh = Math.floor(msToNext / 3600_000), mm = Math.floor(msToNext % 3600_000 / 60_000);
  const dirCol = BTC.dir === 'ALCISTA' ? '#2fe08a' : BTC.dir === 'BAJISTA' ? '#ff5555' : '#8aa0c8';
  const fp = fmtPrice;

  // Razones del veredicto: factores con |score×peso| relevante, ordenados por aporte
  const reasons = [...BTC.factors]
    .filter(f => Math.abs(f.score * f.weight) >= 3)
    .sort((a, b) => Math.abs(b.score * b.weight) - Math.abs(a.score * a.weight))
    .map(f => `<div class="btc-reason"><span style="color:${f.score > 0 ? '#2fe08a' : f.score < 0 ? '#ff6666' : '#8aa0c8'}">${f.score > 0 ? '▲' : f.score < 0 ? '▼' : '·'}</span> ${f.reason}</div>`)
    .join('') || '<div class="btc-reason">Sin factores con señal clara ahora mismo — mejor esperar.</div>';

  // Escalera de niveles clave (de mayor a menor precio)
  const L = BTC.liq || {};
  const lvls = [];
  for (const p of (L.poolsAbove || [])) lvls.push({ price: p.level, label: '🧲 pool de liquidez (equal highs sin barrer)', col: '#4aa8d8' });
  for (const w of (BTC.ob?.askWalls || []).slice(0, 3)) lvls.push({ price: w.price, label: `🧱 muro de VENTA ${fmtUSD(w.usd)} (3 exch.)`, col: '#ff8866' });
  const mpL = BTC.cg?.mp?.price ? { ...BTC.cg.mp, src: ' · Deribit' } : BTC.mp?.price ? { ...BTC.mp, src: '' } : null;
  if (mpL) lvls.push({ price: mpL.price, label: `🎯 max pain opciones (${mpL.expiry})${mpL.src}`, col: '#ffd76a' });
  if (BTC.cg?.clusters?.above) lvls.push({ price: BTC.cg.clusters.above.level, label: `🔥 cluster de liquidaciones ${fmtUSD(BTC.cg.clusters.above.usd)} (heatmap CG)`, col: '#ff9a3c' });
  if (BTC.cg?.clusters?.below) lvls.push({ price: BTC.cg.clusters.below.level, label: `🔥 cluster de liquidaciones ${fmtUSD(BTC.cg.clusters.below.usd)} (heatmap CG)`, col: '#ff9a3c' });
  lvls.push({ price: row.price, label: '● PRECIO ACTUAL', col: '#e8edf8', now: true });
  for (const w of (BTC.ob?.bidWalls || []).slice(0, 3)) lvls.push({ price: w.price, label: `🧱 muro de COMPRA ${fmtUSD(w.usd)} (3 exch.)`, col: '#55dd99' });
  for (const p of (L.poolsBelow || [])) lvls.push({ price: p.level, label: '🧲 pool de liquidez (equal lows sin barrer)', col: '#4aa8d8' });
  lvls.sort((a, b) => b.price - a.price);
  const ladder = lvls.map(l => {
    const d = (l.price - row.price) / row.price * 100;
    return `<div class="btc-lvl${l.now ? ' btc-lvl-now' : ''}">
      <b style="color:${l.col}">${fp(l.price)}</b>
      <span class="btc-lvl-label" style="color:${l.col}">${l.label}</span>
      <span class="btc-lvl-dist">${l.now ? '' : (d >= 0 ? '+' : '') + d.toFixed(2) + '%'}</span>
    </div>`;
  }).join('');

  // Tarjetas de factores
  const cards = BTC.factors.map(f => {
    const val = f.score * f.weight;
    const col = f.score > 0.1 ? '#2fe08a' : f.score < -0.1 ? '#ff6666' : '#8aa0c8';
    return `<div class="btc-factor">
      <div class="btc-factor-head">
        <span>${f.name}</span>
        <b style="color:${col}">${val >= 0 ? '+' : ''}${val.toFixed(0)}</b>
        <span class="btc-factor-w">peso ${f.weight}</span>
      </div>
      <div class="btc-factor-bar"><div style="width:${Math.abs(f.score) * 50}%;margin-left:${f.score >= 0 ? 50 : 50 - Math.abs(f.score) * 50}%;background:${col}"></div></div>
      <div class="btc-factor-reason">${f.reason}</div>
    </div>`;
  }).join('');

  // Historial de sesiones
  const snaps = JSON.parse(localStorage.getItem('scalp_btc_sess') || '[]').slice(-6).reverse();
  const sessRows = snaps.map(s => {
    const move = (row.price - s.price) / s.price * 100;
    const hit = s.dir === 'NEUTRAL' ? null : (s.dir === 'ALCISTA') === (move > 0);
    return `<div class="btc-sess-row">
      <span>${s.id.slice(5, 10)} · <b>${s.key}</b></span>
      <span style="color:${s.dir === 'ALCISTA' ? '#2fe08a' : s.dir === 'BAJISTA' ? '#ff5555' : '#8aa0c8'}">${s.dir} ${s.prob}%</span>
      <span>@ ${fp(s.price)}</span>
      <span class="${move >= 0 ? 'pos' : 'neg'}">${move >= 0 ? '+' : ''}${move.toFixed(2)}% desde apertura</span>
      <span>${hit == null ? '—' : hit ? '✅' : '❌'}</span>
    </div>`;
  }).join('') || '<span class="lr-empty">Los snapshots se guardan solos al abrir cada sesión.</span>';

  const gaugePos = (BTC.bias + 100) / 2;
  el.innerHTML = `
    <div class="btc-top">
      <div class="btc-verdict" style="border-color:${dirCol}50">
        <div class="btc-verdict-head">
          <span class="btc-verdict-prob" style="color:${dirCol}">${BTC.prob}%</span>
          <span class="btc-verdict-dir" style="color:${dirCol}">${BTC.dir}</span>
          <span class="btc-verdict-price">${fp(row.price)}</span>
          <span class="btc-sess">Sesión: <b>${current.key}</b> · ${next.key} en ${hh}h ${mm}m</span>
        </div>
        <div class="btc-gauge"><div class="btc-gauge-marker" style="left:${gaugePos}%"></div></div>
        <div class="btc-gauge-labels"><span>BAJISTA −100</span><span>0</span><span>+100 ALCISTA</span></div>
        <div class="btc-reasons">${reasons}</div>
      </div>
      <div class="btc-ladder">
        <div class="dt-sec-title">Niveles clave ahora</div>
        ${ladder}
      </div>
    </div>
    <div class="btc-chart-wrap${localStorage.getItem('scalp_btc_big') === '1' ? ' expanded' : ''}">
      <canvas id="btc-chart"></canvas>
      <div class="dt-chart-hint" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <button class="chart-tf-btn" id="btc-expand-btn" onclick="btcToggleExpand()">${localStorage.getItem('scalp_btc_big') === '1' ? '⛶ Compactar' : '⛶ Expandir'}</button>
        <button class="chart-tf-btn${typeof _btcSmcOn !== 'undefined' && _btcSmcOn ? ' active' : ''}" id="btc-smc-btn" onclick="btcToggleSMC()" title="Smart Money Concepts: order blocks, fair value gaps y rupturas de estructura (BOS/CHoCH)">🧠 SMC</button>
        <span><b style="color:#4a5870">rueda: zoom · arrastrar: mover · doble clic: hoy</b> · velas 15m (hasta ~10 días)</span>
        <span><span style="color:#4aa8d8">— 🧲 pools</span> · <span style="color:#55dd99">— 🧱 compra</span> · <span style="color:#ff8866">— 🧱 venta</span> · <span style="color:#ffd76a">— 🎯 max pain</span> · <span style="color:#ff9a3c">— 🔥 clusters liq</span> · ⚡ barrido · verticales = sesiones</span>
        <span><span style="color:#2fe08a">— OB/FVG alcista</span> · <span style="color:#ff6666">— OB/FVG bajista</span> · <span style="color:#eef4ff;background:#0b0e14;padding:0 3px;border-radius:2px">texto BOS/CHoCH/OB</span> siempre en blanco: el borde del chip indica la dirección</span>
      </div>
    </div>
    <div class="dt-sec-title" style="margin-top:4px">Factores de confluencia — sesgo total ${BTC.bias >= 0 ? '+' : ''}${BTC.bias}/100</div>
    <div class="btc-factors">${cards}</div>
    <div class="dt-sec-title" style="margin-top:4px">📅 Snapshots por sesión — ¿acertó el sesgo?</div>
    <div class="btc-sessions">${sessRows}</div>
    <div class="cc-note">${(() => {
      const cg = [];
      if (BTC.ob?.exch) {
        const e = BTC.ob.exch;
        cg.push(`🧱 muros: Bybit${e.bybit ? '✓' : '✗'} · Binance${e.binance ? '✓' : '✗'} · OKX${e.okx ? '✓' : '✗'}`);
      }
      cg.push(BTC.cg?.top ? '🐋 top traders ✓' : `🐋 top traders ✗${BTC.cg?.err?.top ? ' (' + BTC.cg.err.top + ')' : ''}`);
      cg.push(BTC.cg?.mp ? '🎯 max pain Deribit ✓' : `🎯 max pain Deribit ✗${BTC.cg?.err?.mp ? ' (' + BTC.cg.err.mp + ')' : ''}`);
      cg.push(BTC.cg?.clusters ? '🔥 heatmap liq. ✓' : `🔥 heatmap liq. ✗${BTC.cg?.err?.hm ? ' (' + BTC.cg.err.hm + ')' : ''}`);
      cg.push(BTC.cg?.cbp ? '🇺🇸 premium ✓' : '🇺🇸 premium ✗');
      cg.push(BTC.cg?.etf ? '🏦 ETF ✓' : '🏦 ETF ✗');
      cg.push(BTC.cg?.taker ? '🔀 spot/perp ✓' : '🔀 spot/perp ✗');
      return `Pesos normalizados sobre los factores activos. Muros de compra/venta: profundidad combinada de Bybit+Binance+OKX. Datos Bybit (gratis) + CoinGlass: ${cg.join(' · ')}. El heatmap de liquidaciones (🔥) requiere plan Professional de CoinGlass — sin él se usa la inferencia estructural (equal highs/lows).`;
    })()}</div>`;

  requestAnimationFrame(() => {
    drawBTCChart(row);
    btcBindChart(document.getElementById('btc-chart'));
  });
}

// ── Gráfico de velas 15m con TODOS los niveles analizados dibujados ─────────
// Historial extendido (~10 días) + zoom con la rueda, arrastre para moverse,
// doble clic para volver a "hoy" y botón ⛶ para expandir la altura.
let _btcView = { span: parseInt(localStorage.getItem('scalp_btc_span') || '96', 10), offset: 0 };
let _btcDrag = null;

function btcChartData() {
  if (BTC.k15x?.k?.c?.length) return BTC.k15x.k;
  return allRows.find(r => r.symbol === 'BTC')?.k15 || null;
}

// Velas 15m extendidas: 1000 velas ≈ 10.4 días (una sola llamada cada 5 min)
async function btcFetchK15x() {
  BTC.k15x = { ...(BTC.k15x || {}), ts: Date.now() };
  try {
    const r = await bybitGet('/v5/market/kline?category=linear&symbol=BTCUSDT&interval=15&limit=1000');
    const list = r.result?.list || [];
    if (list.length < 50) return;
    BTC.k15x = {
      ts: Date.now(),
      k: {
        t: list.map(x => +x[0]).reverse(),
        o: list.map(x => parseFloat(x[1])).reverse(),
        h: list.map(x => parseFloat(x[2])).reverse(),
        l: list.map(x => parseFloat(x[3])).reverse(),
        c: list.map(x => parseFloat(x[4])).reverse(),
        v: list.map(x => parseFloat(x[5])).reverse(),
      },
    };
    if (activeTab === 'btc') { const row = allRows.find(r2 => r2.symbol === 'BTC'); if (row) drawBTCChart(row); }
  } catch (_) {}
}

function btcToggleExpand() {
  const wrap = document.querySelector('.btc-chart-wrap');
  if (!wrap) return;
  const big = wrap.classList.toggle('expanded');
  safeSetItem('scalp_btc_big', big ? '1' : '0');
  const btn = document.getElementById('btc-expand-btn');
  if (btn) btn.textContent = big ? '⛶ Compactar' : '⛶ Expandir';
  const row = allRows.find(r => r.symbol === 'BTC');
  if (row) requestAnimationFrame(() => drawBTCChart(row));
}

// Zoom (rueda) · pan (arrastre) · reset (doble clic). Se re-vincula en cada
// render porque el canvas se reconstruye — usar propiedades on* lo hace idempotente.
//
// El arrastre (mousemove/mouseup) se escucha en `document`, NO en el canvas:
// si solo se escucha en el canvas, en cuanto el mouse sale de sus bordes
// mientras arrastras (muy fácil, el canvas no es toda la pantalla) el
// onmouseleave cortaba el drag de inmediato — se sentía como que "no se
// puede arrastrar". Los listeners de document se enlazan UNA sola vez
// (_btcDragBound) para no acumular duplicados en cada render.
let _btcDragBound = false;
function btcBindChart(canvas) {
  if (!canvas) return;
  const plotW = () => canvas.getBoundingClientRect().width - 216;
  canvas.style.cursor = 'crosshair';
  canvas.onwheel = e => {
    e.preventDefault();
    const k = btcChartData(); if (!k) return;
    const n = k.c.length;
    const factor = e.deltaY < 0 ? 0.8 : 1.25;
    const newSpan = Math.round(Math.max(40, Math.min(n, _btcView.span * factor)));
    const rect = canvas.getBoundingClientRect();
    const frac = 1 - Math.max(0, Math.min(1, (e.clientX - rect.left - 6) / plotW())); // fracción desde el borde derecho
    const anchor = _btcView.offset + frac * _btcView.span; // vela bajo el cursor (en barras desde la derecha)
    _btcView.offset = Math.round(Math.max(0, Math.min(n - newSpan, anchor - frac * newSpan)));
    _btcView.span = newSpan;
    safeSetItem('scalp_btc_span', String(newSpan));
    const row = allRows.find(r => r.symbol === 'BTC'); if (row) drawBTCChart(row);
  };
  canvas.onmousedown = e => {
    e.preventDefault();
    _btcDrag = { x: e.clientX, offset: _btcView.offset };
    canvas.style.cursor = 'grabbing';
  };
  canvas.ondblclick = () => {
    _btcView = { span: 96, offset: 0 };
    safeSetItem('scalp_btc_span', '96');
    const row = allRows.find(r => r.symbol === 'BTC'); if (row) drawBTCChart(row);
  };

  if (!_btcDragBound) {
    _btcDragBound = true;
    document.addEventListener('mousemove', e => {
      if (!_btcDrag) return;
      const cv = document.getElementById('btc-chart'); if (!cv) return;
      const k = btcChartData(); if (!k) return;
      const pw = cv.getBoundingClientRect().width - 216;
      const pxPerBar = pw / _btcView.span;
      const dBars = Math.round((e.clientX - _btcDrag.x) / pxPerBar);
      _btcView.offset = Math.max(0, Math.min(k.c.length - _btcView.span, _btcDrag.offset + dBars));
      cv.style.cursor = 'grabbing';
      const row = allRows.find(r => r.symbol === 'BTC'); if (row) drawBTCChart(row);
    });
    document.addEventListener('mouseup', () => {
      _btcDrag = null;
      const cv = document.getElementById('btc-chart'); if (cv) cv.style.cursor = 'crosshair';
    });
  }
}

function drawBTCChart(row) {
  const canvas = document.getElementById('btc-chart');
  const k = btcChartData();
  if (!canvas || !k || k.c.length < 10) return;

  const W = canvas.width = canvas.clientWidth || 900;
  const H = canvas.height = canvas.clientHeight || 330;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const n = k.c.length;
  const PADL = 6, PADR = 210, PADT = 16, PADB = 18;

  // ── Ventana visible (zoom/pan) ──
  _btcView.span = Math.max(40, Math.min(n, _btcView.span || 96));
  _btcView.offset = Math.max(0, Math.min(n - _btcView.span, _btcView.offset));
  const s1 = n - _btcView.offset; // exclusivo (borde derecho)
  const s0 = s1 - _btcView.span;  // inclusivo (borde izquierdo)

  // ── Recolectar niveles analizados ──
  const L = BTC.liq || {};
  const levels = [];
  for (const p of (L.poolsAbove || [])) levels.push({ v: p.level, col: '#4aa8d8', dash: [5, 4], label: '🧲 pool liquidez' });
  for (const p of (L.poolsBelow || [])) levels.push({ v: p.level, col: '#4aa8d8', dash: [5, 4], label: '🧲 pool liquidez' });
  for (const w of (BTC.ob?.askWalls || []).slice(0, 3)) levels.push({ v: w.price, col: '#ff8866', dash: [], label: `🧱 venta ${fmtUSD(w.usd)}` });
  for (const w of (BTC.ob?.bidWalls || []).slice(0, 3)) levels.push({ v: w.price, col: '#55dd99', dash: [], label: `🧱 compra ${fmtUSD(w.usd)}` });
  const mpL = BTC.cg?.mp?.price ? BTC.cg.mp : BTC.mp;
  if (mpL?.price) levels.push({ v: mpL.price, col: '#ffd76a', dash: [8, 4], label: `🎯 max pain ${mpL.expiry}` });
  if (BTC.cg?.clusters?.above) levels.push({ v: BTC.cg.clusters.above.level, col: '#ff9a3c', dash: [2, 3], label: `🔥 liqs ${fmtUSD(BTC.cg.clusters.above.usd)}` });
  if (BTC.cg?.clusters?.below) levels.push({ v: BTC.cg.clusters.below.level, col: '#ff9a3c', dash: [2, 3], label: `🔥 liqs ${fmtUSD(BTC.cg.clusters.below.usd)}` });

  // ── Rango: velas visibles + niveles que caen dentro (o cerca) de ese rango ──
  let minC = Infinity, maxC = -Infinity;
  for (let i = s0; i < s1; i++) { minC = Math.min(minC, k.l[i]); maxC = Math.max(maxC, k.h[i]); }
  const rp = (maxC - minC) * 0.06 || maxC * 0.001;
  const nearby = levels.filter(l => l.v >= minC - rp && l.v <= maxC + rp);
  let min = minC, max = maxC;
  for (const l of nearby) { min = Math.min(min, l.v); max = Math.max(max, l.v); }
  const pad = (max - min) * 0.04 || max * 0.001;
  min -= pad; max += pad;

  // Deja ~3 velas de espacio vacío a la derecha antes de la franja de
  // etiquetas, para que la última vela no quede pegada al texto (barrido, muro, etc.)
  const RIGHT_MARGIN_BARS = 3;
  const x = i => PADL + (i - s0) / Math.max(1, _btcView.span - 1 + RIGHT_MARGIN_BARS) * (W - PADL - PADR);
  const y = v => PADT + (max - v) / (max - min) * (H - PADT - PADB);

  // ── Grid + eje de precios ──
  ctx.font = '9px Inter,system-ui';
  for (let g = 0; g <= 5; g++) {
    const v = min + (max - min) * g / 5;
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PADL, y(v)); ctx.lineTo(W - PADR, y(v)); ctx.stroke();
    // eje de precios pegado al borde derecho, fuera de la zona de etiquetas
    ctx.fillStyle = '#26334a'; ctx.textAlign = 'right';
    ctx.fillText(fmtPrice(v).replace('$', ''), W - 4, y(v) + 3);
  }

  // ── Aperturas de sesión (líneas verticales, todos los días visibles) ──
  const dayFirst = Math.floor(k.t[s0] / 86_400_000) * 86_400_000;
  const showSessLabels = _btcView.span <= 300; // con mucho zoom-out las etiquetas estorban
  for (let d = dayFirst; d <= k.t[s1 - 1]; d += 86_400_000) {
    for (const s of BTC_SESSIONS) {
      const ts = d + (s.utcH * 60 + s.utcM) * 60_000;
      if (ts < k.t[s0] || ts > k.t[s1 - 1]) continue;
      let idx = -1;
      for (let i = s0; i < s1; i++) if (k.t[i] >= ts) { idx = i; break; }
      if (idx < 0) continue;
      ctx.save();
      ctx.strokeStyle = 'rgba(120,140,180,0.18)'; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
      ctx.beginPath(); ctx.moveTo(x(idx), PADT); ctx.lineTo(x(idx), H - PADB); ctx.stroke();
      ctx.setLineDash([]);
      if (showSessLabels) {
        ctx.fillStyle = 'rgba(120,140,180,0.5)'; ctx.font = '8.5px Inter,system-ui'; ctx.textAlign = 'center';
        ctx.fillText(s.key, x(idx), PADT - 4);
      }
      ctx.restore();
    }
  }

  // ── Smart Money Concepts: zonas de OB/FVG DETRÁS de las velas ──
  if (typeof smcDrawZones === 'function') smcDrawZones(ctx, x, y, s0, s1);

  // ── Velas (solo las visibles) ──
  const bw = Math.max(1.2, (W - PADL - PADR) / _btcView.span * 0.66);
  for (let i = s0; i < s1; i++) {
    const up = k.c[i] >= k.o[i];
    const col = up ? '#1fae74' : '#d24a4a';
    ctx.strokeStyle = col; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x(i), y(k.h[i])); ctx.lineTo(x(i), y(k.l[i])); ctx.stroke();
    ctx.fillStyle = col;
    const yo = y(k.o[i]), yc = y(k.c[i]);
    ctx.fillRect(x(i) - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
  }

  // ── Smart Money Concepts: rupturas de estructura (BOS/CHoCH) sobre las velas ──
  if (typeof smcDrawStructure === 'function') smcDrawStructure(ctx, x, y, s0, s1);

  // ── Niveles analizados: línea + etiqueta con FONDO (chip) apilada sin taparse ──
  const sorted = [...nearby].sort((a, b) => b.v - a.v);
  let lastLy = PADT - 16;
  ctx.font = '700 9.5px Inter,system-ui';
  const labelX = W - PADR + 8;
  const labelMaxW = PADR - 66; // deja libre el eje de precios del borde derecho
  for (const l of sorted) {
    const ly0 = y(l.v);
    // línea del nivel
    ctx.save();
    ctx.strokeStyle = l.col; ctx.lineWidth = 1.3;
    if (l.dash.length) ctx.setLineDash(l.dash);
    ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.moveTo(PADL, ly0); ctx.lineTo(W - PADR, ly0); ctx.stroke();
    ctx.restore();

    // posición apilada (nunca a menos de 15px de la etiqueta anterior)
    let ly = Math.max(ly0, lastLy + 15);
    ly = Math.min(ly, H - PADB - 4);
    lastLy = ly;

    // si no cabe, se acorta la DESCRIPCIÓN pero el precio siempre queda completo
    const priceTxt = fmtPrice(l.v).replace('$', '');
    let lbl = l.label;
    let txt = `${lbl} · ${priceTxt}`;
    while (lbl.length > 4 && ctx.measureText(txt).width > labelMaxW) {
      lbl = lbl.slice(0, -2);
      txt = `${lbl}… · ${priceTxt}`;
    }
    const tw2 = ctx.measureText(txt).width;

    // conector nivel → etiqueta
    ctx.strokeStyle = l.col; ctx.globalAlpha = 0.5; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(W - PADR, ly0); ctx.lineTo(labelX - 3, ly); ctx.stroke();
    ctx.globalAlpha = 1;

    // chip de fondo para que nada se tape
    ctx.fillStyle = 'rgba(4,6,10,0.94)';
    ctx.fillRect(labelX - 3, ly - 8, tw2 + 10, 15);
    ctx.strokeStyle = l.col; ctx.globalAlpha = 0.35; ctx.lineWidth = 1;
    ctx.strokeRect(labelX - 3, ly - 8, tw2 + 10, 15);
    ctx.globalAlpha = 1;
    ctx.fillStyle = l.col; ctx.textAlign = 'left';
    ctx.fillText(txt, labelX + 2, ly + 3);
  }

  // ── Barridos recientes (⚡ en la vela donde se cazaron los stops) ──
  ctx.font = '900 12px Inter,system-ui'; ctx.textAlign = 'center';
  if (L.sweptLow) {
    const i = n - 1 - L.sweptLow.barsAgo;
    if (i >= s0 && i < s1) {
      ctx.fillStyle = '#2fe08a';
      ctx.fillText('⚡', x(i), y(L.sweptLow.level) + 16);
      ctx.font = '700 8px Inter,system-ui';
      ctx.fillText('barrido', x(i), y(L.sweptLow.level) + 26);
      ctx.font = '900 12px Inter,system-ui';
    }
  }
  if (L.sweptHigh) {
    const i = n - 1 - L.sweptHigh.barsAgo;
    if (i >= s0 && i < s1) {
      ctx.fillStyle = '#ff6666';
      ctx.fillText('⚡', x(i), y(L.sweptHigh.level) - 8);
      ctx.font = '700 8px Inter,system-ui';
      ctx.fillText('barrido', x(i), y(L.sweptHigh.level) - 18);
      ctx.font = '900 12px Inter,system-ui';
    }
  }

  // ── Eje de tiempo (fecha·hora en 5 marcas) ──
  ctx.fillStyle = '#2e3c50'; ctx.font = '8.5px Inter,system-ui'; ctx.textAlign = 'center';
  for (let g = 0; g <= 4; g++) {
    const i = Math.round(s0 + (s1 - 1 - s0) * g / 4);
    const d = new Date(k.t[i]);
    ctx.fillText(
      d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' }) + ' ' +
      d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }),
      Math.max(PADL + 28, Math.min(W - PADR - 28, x(i))), H - 5);
  }

  // ── Precio actual: chip blanco en el BORDE DERECHO (zona del eje, sin tapar
  //    las etiquetas de niveles que viven en la franja izquierda del margen) ──
  const lp = row.price || k.c[n - 1];
  if (lp >= min && lp <= max) {
    const lpTxt = fmtPrice(lp).replace('$', '');
    ctx.font = '800 10px Inter,system-ui';
    const tw = ctx.measureText(lpTxt).width;
    ctx.save();
    ctx.strokeStyle = 'rgba(232,237,248,0.7)'; ctx.lineWidth = 1; ctx.setLineDash([1, 3]);
    ctx.beginPath(); ctx.moveTo(PADL, y(lp)); ctx.lineTo(W - tw - 12, y(lp)); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#e8edf8';
    ctx.fillRect(W - tw - 10, y(lp) - 8, tw + 8, 15);
    ctx.fillStyle = '#0b0e14'; ctx.textAlign = 'right';
    ctx.fillText(lpTxt, W - 6, y(lp) + 4);
  }

  // Indicador de zoom (esquina superior izquierda)
  ctx.fillStyle = 'rgba(120,140,180,0.45)'; ctx.font = '8.5px Inter,system-ui'; ctx.textAlign = 'left';
  const hrs = _btcView.span * 0.25;
  ctx.fillText(`${hrs < 48 ? hrs.toFixed(0) + 'h' : (hrs / 24).toFixed(1) + 'd'} visibles${_btcView.offset ? ' · ←' + (_btcView.offset * 0.25).toFixed(0) + 'h del presente' : ''}`, PADL + 4, PADT + 8);
}

// ── Hook por ciclo (lo llama load() en main.js) ─────────────────────────────
function btcOnCycle() {
  const now = Date.now();
  if (now - (BTC.ob?.ts   || 0) > 30_000)      btcFetchOB();
  if (now - (BTC.ls?.ts   || 0) > 60_000)      btcFetchLS();
  if (now - (BTC.mp?.ts   || 0) > 15 * 60_000) btcFetchOptions();
  if (now - (BTC.spot?.ts || 0) > 30_000)      btcFetchSpot();
  if (now - (BTC.cg?.ts   || 0) > 5 * 60_000)  btcFetchCG(); // CoinGlass (caché 60s en el server)
  if (now - (BTC.k15x?.ts || 0) > 5 * 60_000)  btcFetchK15x(); // velas extendidas (~10 días) para el zoom
  btcComputeFactors();
  btcSnapshotSessions();
  if (activeTab === 'btc') renderBTC();
}
