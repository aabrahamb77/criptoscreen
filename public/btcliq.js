/* public/btcliq.js
 * 🔥 Mapa de LIQUIDACIONES PENDIENTES de BTC (estimado), estilo heatmap de CoinGlass.
 *
 * El heatmap de CoinGlass tampoco es un dato "real": nadie publica dónde están
 * los precios de liquidación de cada posición. Es un MODELO que parte del open
 * interest: cuando el OI sube, se abrieron posiciones nuevas a ese precio, y con
 * un reparto típico de apalancamiento se calcula dónde las liquidarían. Esto
 * hace lo mismo con datos gratuitos, todo desde el navegador:
 *
 *   · OI cada 15m de Bybit y de Binance (suma de los dos mayores mercados de perps)
 *   · Reparto compra/venta de cada vela con el taker buy/sell de Binance: si en
 *     la vela dominó la compra agresiva, la mayoría del OI nuevo son largos.
 *   · Apalancamientos 10x · 25x · 50x · 100x (los mismos que muestra CoinGlass)
 *     con margen de mantenimiento 0,5 %: un largo 50x se liquida ~1,5 % abajo.
 *   · Un nivel desaparece cuando el precio lo toca (esa liquidez ya se cobró).
 *   · Cuando el OI baja más de lo que explican las liquidaciones, el resto son
 *     cierres voluntarios y todo lo pendiente se reduce en esa proporción.
 *
 * Resultado: por cada vela de 15m, cuánta liquidez de liquidaciones queda en cada
 * tramo de $100 → se dibuja como mapa de calor (amarillo = mucha) y alimenta el
 * factor "Imanes" del sesgo: el precio tiende a ir a buscar esa liquidez.
 * Es una ESTIMACIÓN: sirve para ver dónde se amontonan, no la cifra exacta.
 */

const LIQM_LEV = [[10, 0.22], [25, 0.28], [50, 0.30], [100, 0.20]]; // [apalancamiento, peso]
const LIQM_MMR = 0.005;
const LIQM_ENTRY = [[0.25, 0.3], [0.5, 0.4], [0.75, 0.3]]; // reparto de la entrada dentro del rango de la vela

const LIQM = {
  oiBy: new Map(),   // ts → OI en BTC (Bybit)
  oiBn: new Map(),   // ts → OI en BTC (Binance)
  tk:   new Map(),   // ts → proporción de compra agresiva (Binance)
  loaded: false, ts: 0, err: null,
};

async function _liqmJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// Primera carga: ~11 días (6 páginas de Bybit, 3 de Binance). Después solo lo último.
async function btcLiqFetch() {
  LIQM.ts = Date.now();
  const full = !LIQM.loaded;
  try {
    // Bybit OI (paginado con cursor, 200 por página)
    let cursor = '';
    for (let p = 0; p < (full ? 6 : 1); p++) {
      const r = await bybitGet('/v5/market/open-interest?category=linear&symbol=BTCUSDT&intervalTime=15min&limit=' + (full ? 200 : 12) +
        (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
      for (const x of (r.result?.list || [])) LIQM.oiBy.set(+x.timestamp, +x.openInterest);
      cursor = r.result?.nextPageCursor;
      if (!cursor) break;
    }
  } catch (e) { LIQM.err = 'Bybit OI: ' + e.message; }

  // Binance OI + taker (si Binance no responde, el modelo sigue solo con Bybit)
  const bn = async (path, onRow) => {
    let end = Date.now();
    for (let p = 0; p < (full ? 3 : 1); p++) {
      const r = await _liqmJSON(`https://fapi.binance.com/futures/data/${path}?symbol=BTCUSDT&period=15m&limit=${full ? 500 : 12}&endTime=${end}`);
      if (!Array.isArray(r) || !r.length) break;
      for (const x of r) onRow(x);
      end = +r[0].timestamp - 1;
    }
  };
  await Promise.all([
    bn('openInterestHist', x => LIQM.oiBn.set(+x.timestamp, +x.sumOpenInterest)).catch(() => {}),
    bn('takerlongshortRatio', x => {
      const b = +x.buyVol, s = +x.sellVol;
      if (b + s > 0) LIQM.tk.set(+x.timestamp, b / (b + s));
    }).catch(() => {}),
  ]);

  // Poda: nada más viejo que 12 días
  const cut = Date.now() - 12 * 86_400_000;
  for (const m of [LIQM.oiBy, LIQM.oiBn, LIQM.tk]) for (const t of m.keys()) if (t < cut) m.delete(t);
  if (LIQM.oiBy.size > 50) LIQM.loaded = true;
  btcLiqCompute();
}

// ── Modelo ──────────────────────────────────────────────────────────────────
function btcLiqCompute() {
  const k = btcChartData();
  if (!k || k.c.length < 100 || LIQM.oiBy.size < 50) return;
  const n = k.c.length;
  const row = allRows.find(r => r.symbol === 'BTC');
  const B = typeof _bookBucket === 'function' ? _bookBucket(row?.price || k.c[n - 1]) : 100;

  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { lo = Math.min(lo, k.l[i]); hi = Math.max(hi, k.h[i]); }
  const p0 = Math.floor(lo * 0.86 / B) * B;
  const nb = Math.ceil((hi * 1.14 - p0) / B) + 1;
  const idx = p => Math.max(0, Math.min(nb - 1, Math.floor((p - p0) / B)));

  const longA = new Float64Array(nb), shortA = new Float64Array(nb);
  const grid = new Float32Array(n * nb);
  let lastBy = null, lastBn = null;
  const DT = 900_000;

  for (let i = 0; i < n; i++) {
    const t = k.t[i];
    // 1) Liquidaciones de esta vela: todo lo que el rango tocó, se cobra
    let consumed = 0;
    for (let b = idx(k.l[i]); b < nb; b++) { if (longA[b]) { consumed += longA[b]; longA[b] = 0; } }
    for (let b = idx(k.h[i]); b >= 0; b--) { if (shortA[b]) { consumed += shortA[b]; shortA[b] = 0; } }

    // 2) Cambio de OI DURANTE la vela: snapshot al final menos al inicio
    let dBTC = 0, totBTC = 0, have = false;
    const by0 = LIQM.oiBy.get(t), by1 = LIQM.oiBy.get(t + DT);
    if (by0 != null && by1 != null) { dBTC += by1 - by0; totBTC += by1; have = true; }
    const bn0 = LIQM.oiBn.get(t), bn1 = LIQM.oiBn.get(t + DT);
    if (bn0 != null && bn1 != null) { dBTC += bn1 - bn0; totBTC += bn1; have = true; }
    if (by1 != null) lastBy = by1;
    if (bn1 != null) lastBn = bn1;

    if (have) {
      const px = (k.h[i] + k.l[i] + k.c[i]) / 3;
      if (dBTC > 0) {
        const N = dBTC * px;
        let buy = LIQM.tk.get(t);
        if (buy == null) buy = k.c[i] >= k.o[i] ? 0.58 : 0.42;
        for (const [f, wE] of LIQM_ENTRY) {
          const entry = k.l[i] + (k.h[i] - k.l[i]) * f;
          for (const [L, wL] of LIQM_LEV) {
            longA[idx(entry * (1 - 1 / L + LIQM_MMR))]  += N * buy * wE * wL;
            shortA[idx(entry * (1 + 1 / L - LIQM_MMR))] += N * (1 - buy) * wE * wL;
          }
        }
      } else if (dBTC < 0 && totBTC > 0) {
        // Lo que bajó el OI y no explican las liquidaciones = cierres voluntarios
        const voluntary = Math.max(0, -dBTC * px - consumed);
        const f = Math.max(0, 1 - voluntary / (totBTC * px));
        if (f < 1) for (let b = 0; b < nb; b++) { longA[b] *= f; shortA[b] *= f; }
      }
    }
    const off = i * nb;
    for (let b = 0; b < nb; b++) grid[off + b] = longA[b] + shortA[b];
  }

  // Clusters vigentes: picos (suavizados ±1 tramo) en ±6 % del precio
  const price = row?.price || k.c[n - 1];
  const peaks = (arr, above) => {
    const out = [];
    for (let b = 1; b < nb - 1; b++) {
      const lvl = p0 + b * B + B / 2;
      const d = (lvl - price) / price;
      if (above ? (d <= 0 || d > 0.06) : (d >= 0 || d < -0.06)) continue;
      const v = arr[b - 1] * 0.5 + arr[b] + arr[b + 1] * 0.5;
      if (v <= 0 || arr[b] < arr[b - 1] || arr[b] < arr[b + 1]) continue;
      out.push({ level: lvl, usd: v, dist: d });
    }
    out.sort((x, y) => y.usd - x.usd);
    // fuera los que estén a menos de 3 tramos de uno mayor
    const kept = [];
    for (const c of out) if (!kept.some(o => Math.abs(o.level - c.level) < 3 * B)) kept.push(c);
    return kept.slice(0, 4);
  };
  const sumIn = (arr, r) => {
    let s = 0;
    for (let b = 0; b < nb; b++) { const lvl = p0 + b * B + B / 2; if (Math.abs(lvl - price) / price <= r) s += arr[b]; }
    return s;
  };

  BTC.liqm = {
    B, p0, nb, n, grid, t0: k.t[0], tN: k.t[n - 1],
    above: peaks(shortA, true), below: peaks(longA, false),
    shortUSD3: sumIn(shortA, 0.03), longUSD3: sumIn(longA, 0.03),
    srcs: { bybit: LIQM.oiBy.size > 50, binance: LIQM.oiBn.size > 50, taker: LIQM.tk.size > 50 },
    oiNow: (lastBy || 0) + (lastBn || 0),
    ts: Date.now(),
  };
}

// ── Dibujo (detrás de las velas) ────────────────────────────────────────────
// Paleta tipo CoinGlass: morado → azul → turquesa → amarillo. Por filas de
// precio, fusionando velas contiguas con la misma intensidad (pocos rects).
const _LIQM_PAL = [[59, 31, 110], [42, 111, 219], [32, 197, 160], [245, 230, 99]];
function _liqmColor(t) {
  const seg = Math.min(_LIQM_PAL.length - 2, Math.floor(t * (_LIQM_PAL.length - 1)));
  const f = t * (_LIQM_PAL.length - 1) - seg;
  const a = _LIQM_PAL[seg], b = _LIQM_PAL[seg + 1];
  return `rgba(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)},${(0.1 + 0.5 * t).toFixed(3)})`;
}

function btcDrawLiqHeat(ctx, x, y, s0, s1, k, vMin, vMax) {
  const M = BTC.liqm;
  if (!M || M.t0 !== k.t[0] || M.n !== k.c.length) return; // modelo de otra serie: esperar al recálculo
  const { B, p0, nb, grid } = M;
  const b0 = Math.max(0, Math.floor((vMin - p0) / B)), b1 = Math.min(nb - 1, Math.ceil((vMax - p0) / B));
  // Escala: percentil 99 de lo visible, para que una celda extrema no apague el resto
  const vals = [];
  for (let i = s0; i < s1; i++) for (let b = b0; b <= b1; b++) { const v = grid[i * nb + b]; if (v > 0) vals.push(v); }
  if (!vals.length) return;
  vals.sort((p, q) => p - q);
  const vRef = vals[Math.floor(vals.length * 0.99)] || vals[vals.length - 1];
  const step = Math.abs(x(s0 + 1) - x(s0)) || 4;
  const Q = 14;
  for (let b = b0; b <= b1; b++) {
    // Banda fina centrada en el tramo (se lee como línea, igual que en CoinGlass);
    // con poco zoom el tramo ya mide 2-3 px y se pinta entero.
    const yTop = y(p0 + (b + 1) * B), yBot = y(p0 + b * B);
    const h = Math.max(1.5, Math.min(yBot - yTop, Math.max(2, (yBot - yTop) * 0.55), 9));
    const ya = (yTop + yBot) / 2 - h / 2;
    let runQ = 0, runStart = s0;
    const flush = end => {
      if (runQ <= 0) return;
      const t = runQ / Q;
      ctx.fillStyle = _liqmColor(t);
      ctx.fillRect(x(runStart) - step / 2, ya, x(end - 1) - x(runStart) + step + 0.5, h);
    };
    for (let i = s0; i < s1; i++) {
      const v = grid[i * nb + b];
      let q = v > 0 ? Math.round(Math.pow(Math.min(1, v / vRef), 0.6) * Q) : 0;
      if (q <= 3) q = 0; // <10 % de la referencia: ruido, no se pinta
      if (q !== runQ) { flush(i); runQ = q; runStart = i; }
    }
    flush(s1);
  }
}
