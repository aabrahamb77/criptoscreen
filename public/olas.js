/* public/olas.js
 * 🌊 OLAS DE VOLUMEN — aviso de que una moneda está explotando al alza, para
 * que el usuario mire el gráfico y decida él si entra (scalp corto, apalancado).
 * Esto es un AVISO, no una señal de entrada: no gestiona ni recomienda nada.
 *
 * Regla (ventana MÓVIL de los últimos 15 minutos, no velas cerradas):
 *   · el precio sube >= 5%
 *   · el volumen negociado es >= 8 veces lo normal (mediana de las velas de 5m
 *     de las 12h anteriores a la ventana)
 *   · al menos $50K negociados en esos 15 min (suelo absoluto: en una moneda
 *     casi muerta, 8 veces "nada" sigue siendo nada)
 *   · y el precio está por encima del máximo de las 4h anteriores (ruptura)
 *
 * Frecuencia medida (21-27 sep 2026, 365 monedas): ~21 avisos/día en las
 * líquidas + ~7 en las finas ($0,5M-$2M/día) ≈ 28/día. Con subida >= 4% serían
 * ~45/día; por eso el 5%. Una subida lenta y sostenida (tipo +6% en 30 min sin
 * llegar nunca a +5% en 15) NO dispara: es otro patrón.
 *
 * Velocidad: en los primeros minutos de una ola el precio corre mucho — medido,
 * un minuto de retraso cuesta entre 0,14% y 0,52% de precio. Por eso:
 *   1) Monedas de la tabla: se evalúan cada 5 s con las operaciones que ya
 *      llegan por el WebSocket (publicTrade → LXR.CVD, última hora en memoria).
 *      Solo cuando la suscripción lleva >= 15 min (si no, la ventana estaría
 *      incompleta) — mientras tanto, con sus velas de 5m y el precio en vivo.
 *   2) El resto del mercado: el ticker de todas llega cada 10 s; las que suben
 *      >= 4% en ~15 min son candidatas y solo para esas se piden sus velas.
 *      Si se confirma, avisa y la moneda pasa a una de las plazas de movimiento
 *      del universo, así sale en la tabla al ciclo siguiente.
 * Nada de esto pasa por Render: todo va del navegador a Bybit.
 *
 * Contexto medido que conviene recordar (ver memoria del proyecto): como
 * estrategia MECÁNICA estas olas rondan el cero tras comisiones, y la
 * "continuidad de volumen" (velas verdes seguidas con volumen) tiende a
 * retroceder primero. El aviso sirve para enterarse a tiempo; la decisión, el
 * gráfico y la gestión son del usuario.
 */

const OLA_VENTANA_MS    = 15 * 60_000;
const OLA_CAMBIO_MIN    = 5;        // % de subida en la ventana
const OLA_RV_MIN        = 8;        // veces el volumen normal
const OLA_USD_MIN       = 50_000;   // negociado mínimo en la ventana
const OLA_BASE_N        = 144;      // 12h de velas de 5m para "lo normal"
const OLA_HI_N          = 48;       // 4h de velas de 5m para el máximo a romper
const OLA_VELA_MS       = 300_000;
const OLA_EVAL_MS       = 5_000;    // cadencia de la vía rápida
const OLA_COOLDOWN_MS   = 60 * 60_000;
const OLA_VIGENTE_MS    = 60 * 60_000;
const OLA_FINA_USD      = 5e6;      // por debajo de esto al día, la moneda se marca como fina

const OLA_PRE_TURNOVER  = 500_000;  // el mismo suelo que el universo del screener
const OLA_PRE_CAMBIO    = 4;        // candidata: un punto por debajo, para llegar antes
const OLA_PRE_MAX_FETCH = 4;
const OLA_PRE_CACHE_MS  = 60_000;
const OLA_PRE_MUESTRA_MS = 50_000;

const _olas = new Map();           // símbolo (sin USDT) → ola detectada
const _olaPrecios = new Map();     // SIMBOLOUSDT → [[ts, precio], ...] (últimos ~20 min)
const _olaPedidas = new Map();     // SIMBOLOUSDT → ts de la última petición de velas

const _olaMediana = a => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };

// ── Regla común a las dos vías ──────────────────────────────────────────────
function _olaCumple(usd, base5m, precioIni, precioAhora, max4h) {
  if (!(usd >= OLA_USD_MIN) || !(base5m > 0) || !(precioIni > 0) || !(precioAhora > 0)) return null;
  const cambio = (precioAhora / precioIni - 1) * 100;
  if (cambio < OLA_CAMBIO_MIN) return null;
  const rv = usd / (3 * base5m);               // 15 min = 3 velas de 5m
  if (rv < OLA_RV_MIN) return null;
  if (!(precioAhora > max4h)) return null;
  return { cambio, rv, usd, precio: precioAhora, max4h };
}

// "Lo normal" y el máximo a romper, con las velas de 5m CERRADAS antes de `desde`.
function _olaContexto(k, desde) {
  let fin = k.t.length - 1;
  while (fin >= 0 && k.t[fin] + OLA_VELA_MS > desde) fin--;
  if (fin < OLA_BASE_N - 1) return null;
  const base = _olaMediana(k.q.slice(fin - OLA_BASE_N + 1, fin + 1));
  let max4h = -Infinity;
  for (let j = Math.max(0, fin - OLA_HI_N + 1); j <= fin; j++) max4h = Math.max(max4h, k.h[j]);
  return { base, max4h };
}

/** Vía rápida: ventana exacta de 15 min con las operaciones del WebSocket.
 *  trades = [{ts, side, size, price}] de viejo a nuevo. */
function olaDesdeTrades(trades, k5, precioAhora, now) {
  if (!trades || !trades.length || !k5) return null;
  const desde = now - OLA_VENTANA_MS;
  let usd = 0, precioIni = null;
  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i];
    if (t.ts < desde) { precioIni = t.price; break; }   // último precio ANTES de la ventana
    usd += t.size * t.price;
  }
  if (precioIni == null) return null;                    // el buffer no llega al inicio
  const ctx = _olaContexto(k5, desde);
  if (!ctx) return null;
  return _olaCumple(usd, ctx.base, precioIni, precioAhora ?? trades[trades.length - 1].price, ctx.max4h);
}

/** Vía de velas: la vela de 5m en curso + las 2 anteriores (10-15 min). La vela
 *  en curso trae volumen parcial, pero el volumen solo puede crecer: si ya
 *  cumple con lo que lleva, cumple. Para monedas de fuera de la tabla o recién
 *  suscritas. `k` de viejo a nuevo { t, o, h, l, c, q }. */
function olaDesdeVelas(k, precioAhora) {
  if (!k || !k.t || k.t.length < OLA_BASE_N + 3) return null;
  const n = k.t.length, i0 = n - 3;
  const usd = k.q[n - 1] + k.q[n - 2] + k.q[n - 3];
  const ctx = _olaContexto(k, k.t[i0]);
  if (!ctx) return null;
  return _olaCumple(usd, ctx.base, k.o[i0], precioAhora ?? k.c[n - 1], ctx.max4h);
}

function _olaDesdeBybit(list) {
  const k = { t: [], o: [], h: [], l: [], c: [], q: [] };
  for (let i = list.length - 1; i >= 0; i--) {
    const b = list[i];
    k.t.push(+b[0]); k.o.push(+b[1]); k.h.push(+b[2]); k.l.push(+b[3]); k.c.push(+b[4]); k.q.push(+b[6]);
  }
  return k;
}

function _olaRegistrar(sym, det, liquidez, fuera) {
  const now = Date.now();
  const prev = _olas.get(sym);
  if (prev && now - prev.detectadaEn < OLA_COOLDOWN_MS) return false;
  const fina = liquidez != null && liquidez < OLA_FINA_USD;
  _olas.set(sym, { sym, ...det, liquidez, fina, fuera, detectadaEn: now });

  if (!canAlert('volWave')) return true;
  const liqTxt = liquidez != null ? ` · $${(liquidez / 1e6).toFixed(1)}M/día${fina ? ' (FINA)' : ''}` : '';
  showToast(`🌊 ${sym} +${det.cambio.toFixed(1)}% en 15m con ${det.rv >= 100 ? Math.round(det.rv) : det.rv.toFixed(0)}× su volumen · rompe máx. 4h${liqTxt}`
    + (fuera ? ' · entra en la tabla al próximo ciclo' : ''), 'long');
  playAlertSound('volWave', 'long');
  notifyDesktop(`🌊 ${sym} explotando: +${det.cambio.toFixed(1)}% en 15 min`,
    `${det.rv.toFixed(0)}× su volumen normal ($${(det.usd / 1e3).toFixed(0)}K en 15 min) · por encima del máximo de 4h (${fmtPrice(det.max4h)}) · precio ${fmtPrice(det.precio)}${liqTxt}`);
  return true;
}

// ── Monedas de la tabla ─────────────────────────────────────────────────────
function _olaEvaluarUniverso(rows) {
  const now = Date.now();
  for (const r of rows) {
    if (!r.k5 || !r.price) continue;
    const prev = _olas.get(r.symbol);
    if (prev && now - prev.detectadaEn < OLA_COOLDOWN_MS) continue;
    // Descarte barato antes de recorrer operaciones: si el precio no ha subido
    // ni un 3,5% desde la vela de hace ~15 min, no hay nada que mirar.
    const k = r.k5;
    let j = k.t.length - 1;
    while (j > 0 && k.t[j] > now - OLA_VENTANA_MS) j--;
    if (!(r.price / k.c[j] - 1 >= 0.035)) continue;

    const desde = typeof wsCoberturaDesde === 'function' ? wsCoberturaDesde(r.symbol) : null;
    const det = (desde && now - desde >= OLA_VENTANA_MS + 10_000 && typeof LXR !== 'undefined')
      ? olaDesdeTrades(LXR.CVD.get(r.symbol), k, r.price, now)
      : olaDesdeVelas(k, r.price);
    if (det) _olaRegistrar(r.symbol, det, r.turnover24h, false);
  }
}

// Desde main.js en cada ciclo de datos (10 s); la vía rápida corre aparte cada 5 s.
function olasOnCycle(rows) {
  _olaEvaluarUniverso(rows);
  const now = Date.now();
  for (const [s, o] of _olas) if (now - o.detectadaEn > Math.max(OLA_COOLDOWN_MS, OLA_VIGENTE_MS)) _olas.delete(s);
  renderOlaStrip(rows);
}
setInterval(() => {
  if (typeof allRows !== 'undefined' && allRows.length) { _olaEvaluarUniverso(allRows); renderOlaStrip(allRows); }
}, OLA_EVAL_MS);

// ── Resto del mercado: llamado desde loadData con todo lo elegible ──────────
function olasRegistrarTickers(elegibles, universo) {
  const now = Date.now();
  const candidatas = [], vivos = new Set();
  for (const t of elegibles) {
    const sym = t.symbol, px = parseFloat(t.lastPrice);
    if (!(px > 0)) continue;
    vivos.add(sym);
    let arr = _olaPrecios.get(sym);
    if (!arr) _olaPrecios.set(sym, arr = []);
    if (!arr.length || now - arr[arr.length - 1][0] >= OLA_PRE_MUESTRA_MS) arr.push([now, px]);
    while (arr.length && now - arr[0][0] > 20 * 60_000) arr.shift();

    if (universo.has(sym)) continue;                         // esas van por la vía de la tabla
    if (parseFloat(t.turnover24h) < OLA_PRE_TURNOVER) continue;
    let ref = null, mejor = Infinity;                        // precio de hace ~15 min (12-18)
    for (const [ts, p] of arr) {
      const edad = now - ts;
      if (edad < 12 * 60_000 || edad > 18 * 60_000) continue;
      const d = Math.abs(edad - 15 * 60_000);
      if (d < mejor) { mejor = d; ref = p; }
    }
    // Recién abierta la página no hay precio de hace 15 min: se usa la subida
    // de la última hora del propio ticker como filtro previo, más laxo.
    const cambio = ref != null ? (px / ref - 1) * 100
                 : (parseFloat(t.prevPrice1h) > 0 ? (px / parseFloat(t.prevPrice1h) - 1) * 100 : null);
    if (cambio != null && cambio >= OLA_PRE_CAMBIO) candidatas.push({ sym, cambio, px, liq: parseFloat(t.turnover24h) });
  }
  for (const s of _olaPrecios.keys()) if (!vivos.has(s)) _olaPrecios.delete(s);

  candidatas.sort((a, b) => b.cambio - a.cambio);
  let pedidas = 0;
  for (const c of candidatas) {
    if (pedidas >= OLA_PRE_MAX_FETCH) break;
    if (now - (_olaPedidas.get(c.sym) || 0) < OLA_PRE_CACHE_MS) continue;
    const s = c.sym.replace('USDT', '');
    const prev = _olas.get(s);
    if (prev && now - prev.detectadaEn < OLA_COOLDOWN_MS) continue;
    _olaPedidas.set(c.sym, now);
    pedidas++;
    _olaComprobarFuera(c);                                   // sin await: no frena el ciclo
  }
  for (const [s, ts] of _olaPedidas) if (now - ts > 30 * 60_000) _olaPedidas.delete(s);
}

async function _olaComprobarFuera(c) {
  try {
    // 200 velas: 144 para "lo normal" + 48 para el máximo de 4h + la ventana.
    const r = await bybitGet(`/v5/market/kline?category=linear&symbol=${c.sym}&interval=5&limit=200`);
    const list = r && r.result && r.result.list;
    if (!list || !list.length) return;
    const det = olaDesdeVelas(_olaDesdeBybit(list), c.px);
    if (det) _olaRegistrar(c.sym.replace('USDT', ''), det, c.liq, true);
  } catch (_) { /* la próxima vuelta lo reintenta */ }
}

// Para loadData: las monedas en ola pasan por delante en las plazas de movimiento.
function olasPrioridad() {
  const out = new Set(), now = Date.now();
  for (const o of _olas.values()) if (now - o.detectadaEn < OLA_VIGENTE_MS) out.add(o.sym + 'USDT');
  return out;
}

// ── Tira bajo el mapa ───────────────────────────────────────────────────────
function renderOlaStrip(rows) {
  const el = document.getElementById('ola-strip');
  if (!el) return;
  const now = Date.now();
  const vigentes = [..._olas.values()]
    .filter(o => now - o.detectadaEn < OLA_VIGENTE_MS)
    .sort((a, b) => b.detectadaEn - a.detectadaEn);
  if (!vigentes.length) { el.innerHTML = ''; el.classList.remove('strip-ready'); return; }

  const precioDe = new Map(rows.map(r => [r.symbol, r.price]));
  const chips = vigentes.map(o => {
    const px = precioDe.get(o.sym);
    const desde = px ? (px / o.precio - 1) * 100 : null;
    const min = Math.max(0, Math.round((now - o.detectadaEn) / 60_000));
    const col = desde == null ? '#8b9098' : desde >= 0 ? '#2fe08a' : '#ff6666';
    const title = `${o.sym}: +${o.cambio.toFixed(1)}% en 15 min con ${o.rv.toFixed(0)}× su volumen normal ($${(o.usd / 1e3).toFixed(0)}K negociados), por encima del máximo de 4h (${fmtPrice(o.max4h)}).`
      + `\nPrecio al avisar: ${fmtPrice(o.precio)}`
      + (o.liquidez != null ? ` · liquidez $${(o.liquidez / 1e6).toFixed(1)}M/día${o.fina ? ' — FINA: tu propia orden puede mover el precio' : ''}` : '')
      + (o.fuera ? '\nDetectada fuera de la tabla: entra al próximo ciclo.' : '');
    const click = px ? `openDetail('${o.sym}','15m')` : `showToast('${o.sym} entra en la tabla en el próximo ciclo', '')`;
    return `<span class="pat-chip pat-breaking" onclick="${click}" title="${title}">
      <b style="color:#7fd4ff">🌊 ${o.sym}</b>
      <span style="color:#2fe08a">+${o.cambio.toFixed(1)}%</span>
      <span style="color:#9fb3cc">${o.rv >= 100 ? Math.round(o.rv) : o.rv.toFixed(0)}×vol</span>
      ${o.fina ? '<span style="color:#ffbe3c" title="Menos de $5M al día: poca liquidez">fina</span>' : ''}
      <span style="color:#8b9098">hace ${min}m</span>
      ${desde == null ? '' : `<b style="color:${col}">${desde >= 0 ? '+' : ''}${desde.toFixed(1)}%</b>`}
    </span>`;
  }).join('');

  el.innerHTML = `<span class="qal-head">🌊 Olas de volumen <span style="font-weight:400;color:#8b9098">· +${OLA_CAMBIO_MIN}% en 15 min con ${OLA_RV_MIN}× su volumen</span></span>${chips}`;
  el.classList.toggle('strip-ready', vigentes.some(o => now - o.detectadaEn < 15 * 60_000));
}
