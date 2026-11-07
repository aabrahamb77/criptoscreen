/* public/btcbook.js
 * 🧱 Muros de compra/venta de BTC sobre el order book COMBINADO de 5 libros.
 *
 * Todo se pide DIRECTO desde el navegador (los 5 exchanges permiten CORS), así
 * que no gasta ni un byte del ancho de banda de Render:
 *   · Bybit perp     1000 niveles  ≈ ±0,3 %
 *   · Binance perp   1000 niveles  ≈ ±0,2 %
 *   · Binance spot   5000 niveles  ≈ ±1,4 %
 *   · OKX perp       5000 niveles  ≈ ±1 %   (tamaño en contratos de 0,01 BTC)
 *   · Hyperliquid    agregado por el exchange en tramos de $100 ≈ ±2,6 %
 *
 * Por qué así: el libro de Bybit con tick de $0,1 solo cubre unos $100 alrededor
 * del precio, y buscar muros en ±3 % con él daba "+0 %" y ningún muro.
 *
 * Cada libro cubre un rango distinto, así que un tramo cercano al precio suma 5
 * libros y uno lejano solo 1 o 2. Para no confundir "más libros" con "más
 * liquidez", la FUERZA de cada tramo de $100 es:
 *     fuerza = USD del tramo (sumando libros) / Σ mediana de cada libro que lo cubre
 * es decir, cuántas veces más gordo es ese tramo que un tramo típico de los
 * libros que lo ven. Muro = fuerza ≥ 2,5 y al menos $2M.
 *
 * Además: antigüedad de cada muro (los que aguantan minutos son más fiables que
 * los que aparecen y desaparecen), aviso de muros retirados cuando el precio se
 * acerca (típico spoofing) y un historial por vela de 15m para el mapa de calor
 * del libro en el gráfico (solo se graba con la app abierta).
 */

const BOOK_WALL_STR = 2.5;     // fuerza mínima para considerar un tramo "muro"
const BOOK_WALL_MIN = 2e6;     // y tamaño mínimo en USD
const BOOK_RANGE    = 0.03;    // los muros se buscan en ±3 %
const BOOK_IMB_RANGE = 0.01;   // el desequilibrio bids/asks se mide en ±1 % (lo cubren casi todos)
const BOOK_HEAT_KEY = 'scalp_btc_obheat';
const BOOK_HEAT_COLS = 144;    // 36 h de velas de 15m

const BOOK_SRC = [
  { key: 'bybit', lbl: 'Bybit',        short: 'BY' },
  { key: 'binF',  lbl: 'Binance perp', short: 'BNf' },
  { key: 'binS',  lbl: 'Binance spot', short: 'BNs' },
  { key: 'okx',   lbl: 'OKX',          short: 'OKX' },
  { key: 'hl',    lbl: 'Hyperliquid',  short: 'HL' },
];

// Tramo de agregación: ~0,13 % del precio redondeado a potencia de 10 ($100 con
// BTC entre ~40K y ~400K). Hyperliquid agrega con "cifras significativas", así
// que se le pide la precisión que da exactamente ese mismo tramo.
function _bookBucket(mid) { return Math.pow(10, Math.round(Math.log10(mid * 0.0013))); }

async function _bookJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// Cada fetcher devuelve { b: [[precio, BTC]], a: [[precio, BTC]], agg? }
const _bookFetchers = {
  bybit: async () => {
    const r = await bybitGet('/v5/market/orderbook?category=linear&symbol=BTCUSDT&limit=1000');
    return { b: r.result?.b || [], a: r.result?.a || [] };
  },
  binF: async () => {
    const r = await _bookJSON('https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=1000');
    return { b: r.bids || [], a: r.asks || [] };
  },
  binS: async () => {
    const r = await _bookJSON('https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=5000');
    return { b: r.bids || [], a: r.asks || [] };
  },
  okx: async () => {
    const r = await _bookJSON('https://www.okx.com/api/v5/market/books-full?instId=BTC-USDT-SWAP&sz=5000');
    const d = r.data?.[0] || {};
    const ct = l => [l[0], (+l[1]) * 0.01]; // contratos → BTC
    return { b: (d.bids || []).map(ct), a: (d.asks || []).map(ct) };
  },
  hl: async (mid, B) => {
    const digits = Math.floor(Math.log10(mid)) + 1;
    const nSigFigs = Math.max(2, Math.min(5, digits - Math.round(Math.log10(B))));
    const r = await _bookJSON('https://api.hyperliquid.xyz/info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'l2Book', coin: 'BTC', nSigFigs }),
    });
    const [b, a] = r.levels || [[], []];
    return { b: b.map(l => [l.px, l.sz]), a: a.map(l => [l.px, l.sz]), agg: true };
  },
};

// Agrega un lado de todos los libros en tramos de B y calcula la fuerza.
function _bookSide(books, side, mid, B) {
  const tot = new Map(), cov = new Map(), src = new Map();
  const keyOf = p => side === 'b' ? Math.floor(p / B + 1e-9) * B : Math.ceil(p / B - 1e-9) * B;
  for (const bk of books) {
    const lv = bk[side];
    if (!lv?.length) continue;
    const m = new Map();
    for (const [ps, qs] of lv) {
      const p = +ps, q = +qs;
      if (!(p > 0 && q > 0)) continue;
      const k = keyOf(p);
      m.set(k, (m.get(k) || 0) + p * q);
    }
    // El último tramo de un libro truncado está a medias: fuera (si no, parece un hueco)
    if (!bk.agg) m.delete(keyOf(+lv[lv.length - 1][0]));
    if (!m.size) continue;
    const vals = [...m.values()].sort((x, y) => x - y);
    const med = vals[Math.floor(vals.length / 2)] || 1;
    for (const [k, u] of m) {
      tot.set(k, (tot.get(k) || 0) + u);
      cov.set(k, (cov.get(k) || 0) + med);
      if (!src.has(k)) src.set(k, {});
      src.get(k)[bk.key] = u;
    }
  }
  const rows = [];
  for (const [k, u] of tot) {
    const center = side === 'b' ? k + B / 2 : k - B / 2;
    if (Math.abs(center - mid) / mid > BOOK_RANGE) continue;
    rows.push({ k, price: center, lo: center - B / 2, hi: center + B / 2, usd: u, str: u / (cov.get(k) || 1), src: src.get(k) });
  }
  rows.sort((x, y) => side === 'b' ? y.k - x.k : x.k - y.k); // del precio hacia fuera
  return rows;
}

// Muros: tramos con fuerza alta. Los contiguos se funden en una sola zona.
function _bookWalls(rows, mid, B) {
  const flagged = rows.filter(r => r.str >= BOOK_WALL_STR && r.usd >= BOOK_WALL_MIN && Math.abs(r.price - mid) > B * 0.6);
  flagged.sort((x, y) => x.k - y.k);
  const merged = [];
  for (const r of flagged) {
    const last = merged[merged.length - 1];
    if (last && r.k - last.kMax <= B + 1e-6) {
      const src = { ...last.src };
      for (const [s, u] of Object.entries(r.src)) src[s] = (src[s] || 0) + u;
      const usd = last.usd + r.usd;
      Object.assign(last, {
        price: (last.price * last.usd + r.price * r.usd) / usd, usd, src,
        lo: Math.min(last.lo, r.lo), hi: Math.max(last.hi, r.hi), str: Math.max(last.str, r.str), kMax: r.k,
      });
    } else merged.push({ ...r, kMax: r.k, src: { ...r.src } });
  }
  merged.sort((x, y) => y.usd - x.usd);
  const walls = merged.slice(0, 4);
  // Libro tranquilo: si hay menos de 3 muros claros, se completan con las
  // "zonas densas" más fuertes (≥1,6×) para no dejar la tarjeta vacía. Van
  // marcadas weak: se pintan más tenues y votan menos en el sesgo.
  if (walls.length < 3) {
    const extra = rows
      .filter(r => r.str >= 1.6 && r.str < BOOK_WALL_STR && r.usd >= 1e6 && Math.abs(r.price - mid) > B * 0.6 &&
        !walls.some(w => r.k >= w.k - B && r.k <= w.kMax + B))
      .sort((x, y) => y.str - x.str)
      .slice(0, 3 - walls.length)
      .map(r => ({ ...r, kMax: r.k, src: { ...r.src }, weak: true }));
    walls.push(...extra);
  }
  return walls;
}

// Texto corto del reparto por exchange: "HL 92% · OKX 6%"
function btcBookSrcTxt(src) {
  const tot = Object.values(src || {}).reduce((a, v) => a + v, 0) || 1;
  return Object.entries(src || {})
    .sort((x, y) => y[1] - x[1])
    .filter(([, v]) => v / tot >= 0.05)
    .slice(0, 3)
    .map(([k, v]) => `${BOOK_SRC.find(s => s.key === k)?.short || k} ${Math.round(v / tot * 100)}%`)
    .join(' · ');
}

// ── Antigüedad de los muros y muros retirados ───────────────────────────────
const _bookSeen = new Map(); // 'b:75800' → { first, last, price, usd }
function _bookTrackAge(side, walls, mid, B, now) {
  for (const w of walls) {
    let hit = null;
    for (const [id, s] of _bookSeen) {
      if (id[0] === side && Math.abs(s.price - w.price) <= B * 1.01) { hit = id; break; }
    }
    if (hit) {
      const s = _bookSeen.get(hit);
      w.first = s.first;
      _bookSeen.delete(hit);
    } else w.first = now;
    _bookSeen.set(`${side}:${Math.round(w.price)}`, { first: w.first, last: now, price: w.price, usd: w.usd, weak: !!w.weak });
  }
  // Muros que llevaban ≥3 min y desaparecen con el precio cerca (<0,35 %): retirados
  for (const [id, s] of [..._bookSeen]) {
    if (id[0] !== side || s.last === now) continue;
    if (now - s.last > 3 * 60_000) { _bookSeen.delete(id); continue; }
    if (s.pulledLogged || s.weak) continue;
    const near = Math.abs(s.price - mid) / mid < 0.0035;
    if (s.last - s.first >= 3 * 60_000 && near) {
      s.pulledLogged = true;
      BTC.book.events.unshift({ ts: now, side, price: s.price, usd: s.usd, age: s.last - s.first });
      BTC.book.events = BTC.book.events.slice(0, 6);
    }
  }
}

// ── Historial por vela de 15m para el mapa de calor del libro ───────────────
let _bookHeat = (() => {
  try { return JSON.parse(localStorage.getItem(BOOK_HEAT_KEY) || '{}'); } catch (_) { return {}; }
})();
let _bookHeatAcc = null;  // { t, n, b: Map(k→{s,u}), a: Map }
let _bookHeatSaved = 0;

function _bookHeatRecord(rowsB, rowsA, B, now) {
  const t = Math.floor(now / 900_000) * 900_000;
  if (!_bookHeatAcc || _bookHeatAcc.t !== t) _bookHeatAcc = { t, n: 0, b: new Map(), a: new Map() };
  const acc = _bookHeatAcc;
  acc.n++;
  for (const [rows, m] of [[rowsB, acc.b], [rowsA, acc.a]]) {
    for (const r of rows) {
      const e = m.get(r.k) || { s: 0, u: 0 };
      e.s += r.str; e.u += r.usd;
      m.set(r.k, e);
    }
  }
  // Se guarda la media de la vela, solo tramos con algo de densidad (fuerza ≥ 1,2)
  const pack = m => [...m.entries()]
    .map(([k, e]) => [k, Math.round(e.s / acc.n * 10), Math.round(e.u / acc.n / 1e5)])
    .filter(x => x[1] >= 12);
  _bookHeat[t] = { B, b: pack(acc.b), a: pack(acc.a) };
  if (now - _bookHeatSaved > 2 * 60_000) {
    _bookHeatSaved = now;
    const keys = Object.keys(_bookHeat).map(Number).sort((x, y) => x - y);
    for (const kk of keys.slice(0, Math.max(0, keys.length - BOOK_HEAT_COLS))) delete _bookHeat[kk];
    // Directo y sin safeSetItem: si no cabe, se pierde el mapa de calor y punto —
    // no debe recortar el historial de señales de otras pestañas para hacerle hueco.
    try { localStorage.setItem(BOOK_HEAT_KEY, JSON.stringify(_bookHeat)); } catch (_) { /* sin espacio */ }
  }
}

function btcBookHeatCols() { return _bookHeat; }

// ── Fetch + cálculo principal ───────────────────────────────────────────────
async function btcBookFetch() {
  if (!BTC.book) BTC.book = { events: [] };
  BTC.book.ts = Date.now();
  BTC.ob = { ...(BTC.ob || {}), ts: Date.now() }; // marca throttle aunque falle
  const row = allRows.find(r => r.symbol === 'BTC');
  const refMid = row?.price || BTC.book.mid;
  if (!refMid) return;
  const B = _bookBucket(refMid);

  const res = await Promise.all(BOOK_SRC.map(s =>
    _bookFetchers[s.key](refMid, B).then(d => ({ key: s.key, ...d })).catch(() => ({ key: s.key, b: [], a: [], fail: true }))));
  const books = res.filter(r => r.b.length && r.a.length);
  if (!books.length) return;
  const exch = Object.fromEntries(res.map(r => [r.key, !r.fail && r.b.length > 0]));

  // Precio medio: mejor bid/ask de los perps más líquidos que hayan respondido
  const ref = books.find(b => b.key === 'bybit') || books.find(b => b.key === 'binF') || books[0];
  const mid = ((+ref.b[0][0]) + (+ref.a[0][0])) / 2;

  const rowsB = _bookSide(books, 'b', mid, B);
  const rowsA = _bookSide(books, 'a', mid, B);
  const now = Date.now();
  const bidWalls = _bookWalls(rowsB, mid, B);
  const askWalls = _bookWalls(rowsA, mid, B);
  _bookTrackAge('b', bidWalls, mid, B, now);
  _bookTrackAge('a', askWalls, mid, B, now);

  const within = (rows, r) => rows.filter(x => Math.abs(x.price - mid) / mid <= r).reduce((a, x) => a + x.usd, 0);
  const bidUSD = within(rowsB, BOOK_IMB_RANGE), askUSD = within(rowsA, BOOK_IMB_RANGE);

  Object.assign(BTC.book, { mid, B, rowsB, rowsA, bidWalls, askWalls, bidUSD, askUSD, exch, ts: now });
  // Compatibilidad: el resto del panel lee BTC.ob
  BTC.ob = { bidWalls, askWalls, bidUSD, askUSD, mid, exch, ts: now };
  _bookHeatRecord(rowsB, rowsA, B, now);
}

// ── Dibujo del mapa de calor del libro (detrás de las velas) ────────────────
// Intensidad = FUERZA media del tramo en esa vela (no USD: así los tramos lejanos
// que solo ven 1-2 libros se comparan en igualdad con los cercanos).
// Verde azulado = bids (compras) · naranja = asks (ventas).
function btcDrawBookHeat(ctx, x, y, s0, s1, k) {
  const cols = _bookHeat;
  const step = Math.abs(x(s0 + 1) - x(s0)) || 4;
  for (let i = s0; i < s1; i++) {
    const c = cols[k.t[i]];
    if (!c) continue;
    const B = c.B || 100;
    const xa = x(i) - step / 2;
    for (const [side, arr] of [['b', c.b], ['a', c.a]]) {
      for (const [kk, s10] of arr) {
        const str = s10 / 10;
        const t = Math.min(1, (str - 1.2) / 4.5);
        if (t <= 0.02) continue;
        const lo = side === 'b' ? kk : kk - B, hi = lo + B;
        const ya = y(hi), yb = y(lo);
        ctx.fillStyle = side === 'b'
          ? `rgba(47,211,200,${(0.08 + 0.55 * t).toFixed(3)})`
          : `rgba(255,138,76,${(0.08 + 0.55 * t).toFixed(3)})`;
        ctx.fillRect(xa, ya, step + 0.5, Math.max(1, yb - ya));
      }
    }
  }
}
