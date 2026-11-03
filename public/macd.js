/* public/macd.js
 * 📊 ESTRATEGIA MACD del usuario — scalp con MACD(15, 26, 34) sobre el cierre,
 * EMA/EMA, esperando al cierre de la vela, en 5m (y a prueba en 15m). Las
 * etiquetas salen de su gráfico:
 *
 *   L   la línea MACD cruza AL ALZA la señal, estando POR ENCIMA de 0 → long
 *   S   la línea MACD cruza A LA BAJA la señal, estando POR DEBAJO de 0 → short
 *   PB  el cruce ocurre al otro lado del 0: rosa = retroceso dentro de una subida
 *       (cruce a la baja sobre 0), verde = rebote dentro de una bajada (cruce al
 *       alza bajo 0)
 *   ▲▼  la línea MACD cruza el 0: continuidad de tendencia en esa dirección
 *
 * Cada etiqueta es el paso de un "cuadrante" a otro (MACD sobre/bajo la señal y
 * sobre/bajo 0), así que la última etiqueta dice en qué estado está la moneda.
 *
 * Objetivo: cobrar 5% a 10x, o sea 0,5% de precio. El usuario no definió stop. Lo
 * que dio medido en 100 monedas y un mes (5m): con objetivo o cruce contrario llega
 * el 44% (haría falta el 56%) y pierde −1,18% de margen por operación; sin stop
 * llega el 94% y pierde −1,29%, porque cada liquidación borra 24 ganadoras. Una
 * entrada al azar con la misma salida da lo mismo: la pérdida es casi toda la
 * comisión, que a 10x son 0,85-1,30% del margen en cada vuelta. Para ir ajustando
 * la estrategia, las operaciones viven en el paper trading (macdpaper.js).
 *
 * Aviso: el usuario quiere enterarse del cruce confirmado lo antes posible, así
 * que cada cierre llega por el WebSocket (kline.5 y kline.15 con confirm=true) y se
 * evalúa en el momento, sin esperar a ninguna descarga. Las monedas que cruzan en
 * el mismo cierre van en un solo aviso: ~8 por hora en 5m y ~2,6 en 15m.
 *
 * Datos: la historia son 200 velas de 5m y 15m, descargadas al entrar la moneda.
 * Después solo se descarga si el WebSocket no trae el cierre a tiempo (o para una
 * moneda fuera de la tabla con operación abierta). Todo va del navegador a Bybit,
 * sin pasar por Render. Como las señales salen de velas cerradas se pueden
 * reconstruir: al volver a abrir la pestaña se procesan las que faltan, hasta 80
 * (de las 200, las primeras 120 son de arranque del EMA): 6,7h en 5m y 20h en 15m.
 */

const MACD_FAST   = 15;
const MACD_SLOW   = 26;
const MACD_SIGNAL = 34;
const MACD_TFS = ['5m', '15m'];
const MACD_TF = {
  '5m':  { ms: 300_000, api: '5',  cat: 'macd5'  },
  '15m': { ms: 900_000, api: '15', cat: 'macd15' },
};
const MACD_LEV        = 10;     // apalancamiento con el que opera el usuario
const MACD_TP_PCT     = 0.5;    // objetivo en precio: 5% de margen a 10x
const MACD_VELAS      = 200;
const MACD_WARMUP     = 120;    // antes de esta vela el EMA aún arrastra su valor inicial
const MACD_MIN_VELAS  = 70;     // moneda recién listada: menos que esto no da un MACD fiable
const MACD_MARGEN_MS  = 6_000;  // tras el cierre, tiempo que tiene el WebSocket antes de descargar
const MACD_RAFAGA_MS  = 1000;   // las monedas de un cierre llegan repartidas en ~1 s: así van en un solo aviso
const MACD_MAX_VELAS  = 260;    // con el WebSocket la serie crece; se recorta a MACD_VELAS
const MACD_WORKERS    = 5;
const MACD_MAX_LOTE   = 120;    // peticiones como mucho por tanda
const MACD_REVISAR_MS = 2_000;  // cada cuánto se mira si ha cerrado una vela (en 5m importa)
const MACD_FRESCA     = 3;      // velas que una L/S sigue en la tira
const MACD_STRIP_MAX  = 16;
const MACD_MARCA_MAX_MS = 3 * 864e5; // más que la ventana de 15m (200 velas = 50h)
const MACD_AVISO_MAX_MS = 3 * 60_000; // no avisar de una vela cerrada hace más de esto

// Se opera lo que el usuario opera: L y S. Los PB y las flechas se ven, no se siguen.
const MACD_ENTRADAS = { L: 1, S: -1 };
const MACD_ETIQUETA = { L: 'L', S: 'S', UP: '▲', DN: '▼', PBR: 'PB', PBV: 'PB' };
const MACD_ESTADO_TXT = {
  long:  'LONG',
  short: 'SHORT',
  pbr:   'PB: retroceso en subida',
  pbv:   'PB: rebote en bajada',
};
const MACD_ESTADO_COL = { long: '#2fe08a', short: '#ff6680', pbr: '#ffb3c1', pbv: '#a8f0d0' };

const _macdData    = new Map();  // 'SYM|tf' → velas, MACD y etiquetas
const _macdEnVuelo = new Set();
const _macdFallo   = new Map();  // 'SYM|tf' → no reintentar hasta este ts
let _macdDrenando  = false;
const _macdAvisosVacios = () => ({ '5m': { L: [], S: [] }, '15m': { L: [], S: [] } });
let _macdAvisos    = _macdAvisosVacios();
let _macdRafaga    = null;
let macdStripAbierta = false;
let macdTfVista = (() => {
  try { const v = localStorage.getItem('scalp_macd_tf'); return MACD_TF[v] ? v : '5m'; } catch (_) { return '5m'; }
})();

// Clave propia: una pestaña abierta con una versión anterior sigue escribiendo en
// la vieja y no debe pisar el paper trading.
const _MACD_KEY = 'scalp_macd_paper';
const _macdStoreVacio = () => ({ v: 3, marcas: {}, variantes: null, sel: null });
let _macdStore = (() => {
  try {
    localStorage.removeItem('scalp_macd');    // seguimiento de versiones anteriores, ya no se lee
    const s = JSON.parse(localStorage.getItem(_MACD_KEY) || 'null');
    if (s && s.v === 3) return s;
  } catch (_) { /* dato roto: se empieza de cero */ }
  return _macdStoreVacio();
})();
let _macdSucio = false;

// Dos pestañas abiertas no deben contar lo mismo dos veces: la que guarda avisa
// a la otra, que adopta las variantes y las marcas de vela procesada.
window.addEventListener('storage', e => {
  if (e.key !== _MACD_KEY || !e.newValue) return;
  try { const s = JSON.parse(e.newValue); if (s && s.v === 3) _macdStore = s; } catch (_) { /* se ignora */ }
});

// ── Cálculo ─────────────────────────────────────────────────────────────────
function _macdEma(v, len) {
  const a = 2 / (len + 1), out = new Array(v.length);
  let e = v[0];
  for (let i = 0; i < v.length; i++) {
    if (i) e = a * v[i] + (1 - a) * e;
    out[i] = e;
  }
  return out;
}

function macdCalcular(cierres, rapida = MACD_FAST, lenta = MACD_SLOW, senal = MACD_SIGNAL) {
  const r = _macdEma(cierres, rapida), l = _macdEma(cierres, lenta);
  const macd = cierres.map((_, i) => r[i] - l[i]);
  const sig = _macdEma(macd, senal);
  return { macd, sig, hist: macd.map((m, i) => m - sig[i]) };
}

// Etiquetas de la vela i. El cruce va al final: si coinciden en la misma vela, la
// etiqueta que resume el estado es L/S y no la flecha.
function macdEventos(m, i) {
  if (i < 1) return [];
  const out = [];
  const z0 = m.macd[i - 1], z1 = m.macd[i], d0 = m.hist[i - 1], d1 = m.hist[i];
  if (z0 <= 0 && z1 > 0) out.push('UP');
  if (z0 >= 0 && z1 < 0) out.push('DN');
  if (d0 <= 0 && d1 > 0) out.push(z1 > 0 ? 'L' : 'PBV');
  if (d0 >= 0 && d1 < 0) out.push(z1 < 0 ? 'S' : 'PBR');
  return out;
}

function macdEstado(m, i) {
  const sobreSenal = m.macd[i] > m.sig[i], sobreCero = m.macd[i] > 0;
  return sobreSenal ? (sobreCero ? 'long' : 'pbv') : (sobreCero ? 'pbr' : 'short');
}

// ── Velas ───────────────────────────────────────────────────────────────────
// `list` tal como la da Bybit (más nueva primero). Solo cuenta como cerrada la
// vela que ya lo estaba al descargarla.
function _macdIngerir(sym, tf, list, fetchedAt) {
  const ms = MACD_TF[tf].ms;
  const d = { t: [], o: [], h: [], l: [], c: [], fetchedAt, visto: Date.now() };
  for (let i = list.length - 1; i >= 0; i--) {
    const b = list[i];
    d.t.push(+b[0]); d.o.push(+b[1]); d.h.push(+b[2]); d.l.push(+b[3]); d.c.push(+b[4]);
  }
  let n = d.t.length;
  while (n > 0 && d.t[n - 1] + ms > fetchedAt) n--;
  d.n = n;
  if (n >= MACD_MIN_VELAS) _macdRecalcular(sym, tf, d);
  _macdData.set(sym + '|' + tf, d);
  return d;
}

function _macdRecalcular(sym, tf, d) {
  d.m = macdCalcular(d.c.slice(0, d.n));
  d.mOtros = {};
  d.desde = Math.min(MACD_WARMUP, Math.floor(d.n * 0.6));
  d.eventos = [];
  for (let i = d.desde; i < d.n; i++) for (const tipo of macdEventos(d.m, i)) d.eventos.push({ i, tipo });
  _macdProcesar(sym, tf, d);
}

// ── Cierres por WebSocket: la vía rápida ────────────────────────────────────
// Desde screener.js con cada mensaje kline.*; solo interesa el que confirma el cierre.
function macdOnKline(msg) {
  const [, api, par] = msg.topic.split('.');
  const tf = MACD_TFS.find(x => MACD_TF[x].api === api);
  if (!tf) return;
  const sym = par.replace('USDT', '');
  for (const v of msg.data) if (v.confirm) _macdVelaConfirmada(sym, tf, v);
}

function _macdVelaConfirmada(sym, tf, v) {
  const d = _macdData.get(sym + '|' + tf);
  if (!d || !d.m) return;                 // aún sin historia: la traerá la descarga
  const ms = MACD_TF[tf].ms, t = +v.start, ult = d.t[d.n - 1];
  if (t <= ult) return;                   // la descarga llegó antes
  if (t !== ult + ms) { d.fetchedAt = 0; return; } // falta una vela: que la rellene la descarga
  for (const [k, campo] of [['o', 'open'], ['h', 'high'], ['l', 'low'], ['c', 'close']]) {
    d[k].length = d.n;                    // fuera la vela en curso de la última descarga
    d[k].push(+v[campo]);
  }
  d.t.length = d.n;
  d.t.push(t);
  d.n++;
  if (d.n > MACD_MAX_VELAS) {
    const cut = d.n - MACD_VELAS;
    for (const k of ['t', 'o', 'h', 'l', 'c']) d[k] = d[k].slice(cut);
    d.n = MACD_VELAS;
  }
  // Como si se hubiera descargado pasado el margen: esta vela ya no hace falta pedirla.
  d.fetchedAt = t + ms + MACD_MARGEN_MS;
  _macdRecalcular(sym, tf, d);
  if (!_macdRafaga) _macdRafaga = setTimeout(() => { _macdRafaga = null; _macdTrasLote(); }, MACD_RAFAGA_MS);
}

async function _macdPedir(sym, tf) {
  const key = sym + '|' + tf, fetchedAt = Date.now();
  _macdEnVuelo.add(key);
  try {
    const r = await bybitGet(`/v5/market/kline?category=linear&symbol=${sym}USDT&interval=${MACD_TF[tf].api}&limit=${MACD_VELAS}`);
    const list = r && r.result && r.result.list;
    if (list && list.length) { _macdIngerir(sym, tf, list, fetchedAt); _macdFallo.delete(key); }
    else _macdFallo.set(key, Date.now() + 120_000);
  } catch (_) {
    _macdFallo.set(key, Date.now() + 60_000);
  } finally {
    _macdEnVuelo.delete(key);
  }
}

// Una vela de esta TF ha cerrado desde la última descarga.
function _macdHaceFalta(d, tf, now) {
  if (!d) return true;
  const ms = MACD_TF[tf].ms;
  return Math.floor((now - MACD_MARGEN_MS) / ms) > Math.floor((d.fetchedAt - MACD_MARGEN_MS) / ms);
}

async function _macdDrenar(pendientes) {
  if (_macdDrenando || !pendientes.length) return;
  _macdDrenando = true;
  try {
    let idx = 0;
    const lote = pendientes.slice(0, MACD_MAX_LOTE);
    const trabajador = async () => { while (idx < lote.length) { const x = lote[idx++]; await _macdPedir(x.sym, x.tf); } };
    await Promise.all(Array.from({ length: MACD_WORKERS }, trabajador));
    _macdTrasLote();
  } finally {
    _macdDrenando = false;
  }
}

// Qué monedas hay que seguir en cada TF: las de la tabla, y las que tienen una
// operación abierta en esa TF aunque hayan salido de la tabla.
function _macdVivas(rows) {
  const out = {};
  for (const tf of MACD_TFS) out[tf] = new Set(rows.map(r => r.symbol));
  for (const [tf, sym] of paperMonedasAbiertas()) if (out[tf]) out[tf].add(sym);
  return out;
}

function _macdPlanificar(rows) {
  const now = Date.now();
  if (typeof _bybitBanUntil !== 'undefined' && now < _bybitBanUntil) return;
  if (_macdDrenando) return;
  const vivas = _macdVivas(rows), pendientes = [];
  // Primero la temporalidad que se está mirando: al abrir la página es la que
  // tiene que aparecer antes.
  for (const tf of [macdTfVista, ...MACD_TFS.filter(x => x !== macdTfVista)]) {
    for (const sym of vivas[tf]) {
      const key = sym + '|' + tf;
      if (_macdEnVuelo.has(key) || now < (_macdFallo.get(key) || 0)) continue;
      if (_macdHaceFalta(_macdData.get(key), tf, now)) pendientes.push({ sym, tf });
    }
  }
  _macdDrenar(pendientes);
}

// Desde main.js en cada ciclo de datos.
function macdOnCycle(rows) {
  const now = Date.now();
  _macdPlanificar(rows);
  const vivas = _macdVivas(rows);
  for (const [key, d] of _macdData) {
    const [sym, tf] = key.split('|');
    if (vivas[tf] && vivas[tf].has(sym)) d.visto = now;
    else if (now - d.visto > 30 * 60_000) _macdData.delete(key);
  }
  macdActualizarFilas(rows);
  renderMacdStrip(rows);
  if (typeof activeTab !== 'undefined' && activeTab === 'lab') renderMacdPanel();
  _macdGuardar();
}

// El ciclo de datos va cada 10 s; en 5m eso es demasiado para enterarse del cierre.
setInterval(() => {
  if (typeof allRows !== 'undefined' && allRows.length) _macdPlanificar(allRows);
}, MACD_REVISAR_MS);

function macdActualizarFilas(rows) {
  for (const r of rows) r.macdOrden = _macdOrden(r.symbol);
}

function _macdGuardar() {
  if (!_macdSucio) return;
  _macdSucio = false;
  if (typeof safeSetItem === 'function') safeSetItem(_MACD_KEY, JSON.stringify(_macdStore));
}

// ── Velas cerradas ──────────────────────────────────────────────────────────
// Cada vela se mira una sola vez: la marca dice hasta dónde se llegó y sobrevive a
// recargar la página. De aquí salen el aviso y las operaciones de papel.
function _macdProcesar(sym, tf, d) {
  const key = sym + '|' + tf, ult = d.n - 1;
  const marca = _macdStore.marcas[key] || 0;
  if (ult < 1 || d.t[ult] <= marca) return;
  if (Date.now() - (d.t[ult] + MACD_TF[tf].ms) < MACD_AVISO_MAX_MS) {
    for (const tipo of macdEventos(d.m, ult)) {
      if (tipo in MACD_ENTRADAS) _macdAvisos[tf][tipo].push({ sym, px: d.o[ult + 1] ?? d.c[ult] });
    }
  }
  paperProcesar(sym, tf, d, marca);
  _macdStore.marcas[key] = d.t[ult];
  _macdSucio = true;
}

function _macdTrasLote() {
  const now = Date.now();
  for (const k of Object.keys(_macdStore.marcas)) {
    if (now - _macdStore.marcas[k] > MACD_MARCA_MAX_MS) delete _macdStore.marcas[k];
  }
  paperLimpiar(now);
  _macdGuardar();
  if (typeof allRows !== 'undefined' && allRows.length) {
    macdActualizarFilas(allRows);
    renderMacdStrip(allRows);
  }
  const avisos = _macdAvisos;
  _macdAvisos = _macdAvisosVacios();
  for (const tf of MACD_TFS) {
    const { L, S } = avisos[tf];
    if ((!L.length && !S.length) || typeof canAlert !== 'function' || !canAlert(MACD_TF[tf].cat)) continue;
    const nombres = a => { const n = a.slice(0, 12).map(x => x.sym).join(', '); return a.length > 12 ? `${n} +${a.length - 12}` : n; };
    const txt = [L.length ? `LONG: ${nombres(L)}` : '', S.length ? `SHORT: ${nombres(S)}` : ''].filter(Boolean).join(' · ');
    const dir = L.length >= S.length ? 'long' : 'short';
    showToast(`📊 MACD ${tf} — cruce confirmado · ${txt}`, dir);
    playAlertSound(MACD_TF[tf].cat, dir);
    const uno = L.length + S.length === 1 ? (L[0] || S[0]) : null;
    notifyDesktop(`📊 MACD ${tf}: cruce confirmado`,
      uno ? `${txt} · precio ${fmtPrice(uno.px)} · objetivo ${fmtPrice(uno.px * (1 + (L.length ? 1 : -1) * MACD_TP_PCT / 100))} (5% a ${MACD_LEV}x)` : txt);
  }
}

// ── Lectura ─────────────────────────────────────────────────────────────────
function macdResumen(sym, tf) {
  const d = _macdData.get(sym + '|' + tf);
  if (!d || !d.m || !d.eventos) return null;
  const ult = d.n - 1;
  const ms = MACD_TF[tf].ms;
  const info = ev => ev && { tipo: ev.tipo, i: ev.i, velas: ult - ev.i, cierre: d.t[ev.i] + ms, ref: d.o[ev.i + 1] ?? d.c[ev.i] };
  let ls = null;
  for (let j = d.eventos.length - 1; j >= 0; j--) {
    if (d.eventos[j].tipo === 'L' || d.eventos[j].tipo === 'S') { ls = d.eventos[j]; break; }
  }
  return { estado: macdEstado(d.m, ult), ultima: info(d.eventos[d.eventos.length - 1]), ultimaLS: info(ls) };
}

// Para ordenar la tabla. El primer clic en una columna ordena de menor a mayor,
// así que las L más frescas son los valores más bajos y las S los más altos: un
// clic deja arriba las L y el segundo, las S. Sin datos va en medio, no arriba.
function _macdOrden(sym) {
  const r = macdResumen(sym, macdTfVista);
  if (!r || !r.ultima) return 0;
  const peso = { L: -1000, UP: -500, PBV: -100, PBR: 100, DN: 500, S: 1000 }[r.ultima.tipo];
  return peso < 0 ? peso + r.ultima.velas : peso - r.ultima.velas;
}

function _macdEtiquetaCol(tipo) {
  return { L: '#2fe08a', UP: '#2fe08a', S: '#ff6680', DN: '#ff6680', PBR: '#ffb3c1', PBV: '#a8f0d0' }[tipo];
}

// ── Celda de la tabla ───────────────────────────────────────────────────────
function macdCelda(sym) {
  return `<div class="macd-celda">${MACD_TFS.map(tf => {
    const r = macdResumen(sym, tf);
    if (!r || !r.ultima) return `<i class="macd-tag" title="${tf}: sin datos todavía">·</i>`;
    const u = r.ultima;
    const fresca = u.velas <= 1;
    const title = `${tf}: ${MACD_ESTADO_TXT[r.estado]} · última etiqueta ${MACD_ETIQUETA[u.tipo]} ${patAgo(Date.now() - u.cierre)} (${u.velas} velas)`;
    return `<i class="macd-tag${fresca ? ' fresca' : ''}" style="color:${_macdEtiquetaCol(u.tipo)}" title="${title}">${MACD_ETIQUETA[u.tipo]}</i>`;
  }).join('')}</div>`;
}

// ── Tira bajo el mapa ───────────────────────────────────────────────────────
function setMacdTf(tf) {
  if (!MACD_TF[tf]) return;
  macdTfVista = tf;
  if (typeof safeSetItem === 'function') safeSetItem('scalp_macd_tf', tf);
  if (typeof allRows !== 'undefined' && allRows.length) {
    macdActualizarFilas(allRows);
    renderMacdStrip(allRows);
    if (typeof render === 'function') render();
  }
}
function toggleMacdStrip() {
  macdStripAbierta = !macdStripAbierta;
  if (typeof allRows !== 'undefined' && allRows.length) renderMacdStrip(allRows);
}

// Lo que lleva sobre el margen, a favor de la señal: positivo es que va bien.
function _macdMargen(tipo, ref, precio) {
  if (!(ref > 0) || !(precio > 0)) return null;
  return (MACD_ENTRADAS[tipo] || 1) * (precio / ref - 1) * 100 * MACD_LEV;
}

// Si la señal ya cobró ('T') o el MACD se dio la vuelta antes ('C'). Sale de las
// velas: no depende de ninguna variante del paper trading, que se pueden borrar.
function _macdOperacion(sym, tf, ls) {
  const d = _macdData.get(sym + '|' + tf);
  if (!d || !d.m) return null;
  const dir = MACD_ENTRADAS[ls.tipo], h = d.m.hist;
  for (let j = ls.i + 1; j < d.n; j++) {
    const fav = dir > 0 ? (d.h[j] / ls.ref - 1) * 100 : (1 - d.l[j] / ls.ref) * 100;
    if (fav >= MACD_TP_PCT) return 'T';
    if (dir > 0 ? h[j - 1] >= 0 && h[j] < 0 : h[j - 1] <= 0 && h[j] > 0) return 'C';
  }
  return null;
}

// Lo reciente se lee en minutos, y lo que acaba de pasar no es "hace 0m".
function _macdHace(ms) { return ms < 60_000 ? 'ahora' : patAgo(ms).replace('hace ', ''); }

function _macdTextoMargen(tipo, ref, precio, resultado) {
  if (resultado === 'T') return `<b style="color:#2fe08a" title="Ya tocó el objetivo: entrar ahora sería llegar tarde">🎯 cobrada</b>`;
  if (resultado === 'C') return `<span style="color:#c8d0dc" title="El MACD ya se dio la vuelta sin llegar al objetivo">cruce</span>`;
  const m = _macdMargen(tipo, ref, precio);
  return m == null ? '' : `<span style="color:${m >= 0 ? '#2fe08a' : '#ff6680'}">${m >= 0 ? '+' : ''}${m.toFixed(1)}%</span>`;
}

function renderMacdStrip(rows) {
  const el = document.getElementById('macd-strip');
  if (!el) return;
  const tf = macdTfVista;
  const estados = { long: 0, short: 0, pb: 0 };
  const items = [];
  for (const r of rows) {
    const res = macdResumen(r.symbol, tf);
    if (!res) continue;
    if (res.estado === 'long') estados.long++;
    else if (res.estado === 'short') estados.short++;
    else estados.pb++;
    const ls = res.ultimaLS;
    if (ls && ls.velas < MACD_FRESCA) items.push({ r, ls });
  }
  items.sort((a, b) => a.ls.velas - b.ls.velas || (a.ls.tipo === 'L' ? -1 : 1));
  const nL = items.filter(x => x.ls.tipo === 'L').length;
  const nS = items.length - nL;
  // Recién confirmada = la vela del cruce es la última cerrada. Es lo que caduca:
  // lleva marca propia y enciende la tira, igual que las rupturas de W/M.
  const nRecien = items.filter(x => x.ls.velas === 0).length;
  el.classList.toggle('strip-ready', nRecien > 0);

  const btns = MACD_TFS.map(t => `<button class="chart-tf-btn${t === tf ? ' active' : ''}" onclick="setMacdTf('${t}')">${t}</button>`).join('');
  const vis = macdStripAbierta ? items : items.slice(0, MACD_STRIP_MAX);
  const chips = vis.map(({ r, ls }) => {
    const esL = ls.tipo === 'L';
    const op = _macdOperacion(r.symbol, tf, ls);
    const recien = ls.velas === 0;
    return `<span class="pat-chip${recien ? ' pat-breaking' : ''}" onclick="openDetail('${r.symbol}','${tf}')" title="${r.symbol}: ${esL ? 'cruce al alza por ENCIMA de 0 (long)' : 'cruce a la baja por DEBAJO de 0 (short)'} en ${tf} · cerró ${patAgo(Date.now() - ls.cierre)} · entrada de referencia ${fmtPrice(ls.ref)} · objetivo ${fmtPrice(ls.ref * (1 + (esL ? 1 : -1) * MACD_TP_PCT / 100))} (5% a ${MACD_LEV}x). El % es sobre margen a ${MACD_LEV}x.">
      ${recien ? '🔴 ' : ''}${r.symbol} <b style="color:${esL ? '#2fe08a' : '#ff6680'}">${ls.tipo}</b>
      <span style="color:#c8d0dc">${_macdHace(Date.now() - ls.cierre)}</span>
      ${_macdTextoMargen(ls.tipo, ls.ref, r.price, op)}
    </span>`;
  }).join('');
  const ocultas = items.length - vis.length;
  const mas = ocultas > 0
    ? `<span class="pat-chip pat-chip-more" onclick="toggleMacdStrip()">+${ocultas} más</span>`
    : (macdStripAbierta && items.length > MACD_STRIP_MAX ? `<span class="pat-chip pat-chip-more" onclick="toggleMacdStrip()">− menos</span>` : '');

  el.innerHTML = `<span class="qal-head">📊 MACD 15·26·34</span>${btns}
    <span class="macd-resumen" title="Estado de todas las monedas de la tabla en ${tf}">
      <b style="color:#2fe08a">${estados.long} long</b> · <b style="color:#ff6680">${estados.short} short</b> · ${estados.pb} en PB</span>
    ${items.length ? `<span class="macd-resumen">— recientes: <b style="color:#2fe08a">${nL} L</b> · <b style="color:#ff6680">${nS} S</b>${nRecien ? ` <b style="color:#ffd76a">(${nRecien} recién)</b>` : ''} <span style="opacity:.7">(% sobre margen a ${MACD_LEV}x)</span></span>` : ''}
    ${chips}${mas}`;
}

// ── Panel de detalle ────────────────────────────────────────────────────────
function macdSeccionDetalle(row) {
  const filas = MACD_TFS.map(tf => {
    const r = macdResumen(row.symbol, tf);
    if (!r) return `<div class="dt-row"><span>${tf}</span><b style="color:#c8d0dc">cargando…</b></div>`;
    const ls = r.ultimaLS;
    const m = ls ? _macdMargen(ls.tipo, ls.ref, row.price) : null;
    return `<div class="dt-row"><span>${tf}</span><b style="color:${MACD_ESTADO_COL[r.estado]}">${MACD_ESTADO_TXT[r.estado]}${ls ? ` · ${ls.tipo} ${patAgo(Date.now() - ls.cierre)}` : ''}${m == null ? '' : ` · ${m >= 0 ? '+' : ''}${m.toFixed(1)}% a ${MACD_LEV}x`}</b></div>`;
  }).join('');
  return `<div class="dt-section"><div class="dt-sec-title">📊 MACD 15·26·34 (velas cerradas)</div>${filas}</div>`;
}

// Mismo eje X que las velas del gráfico (mismos start, N y márgenes).
function macdDibujarPanel(sym, tf, k, start, N, RGAP, PADL, PADR) {
  const canvas = document.getElementById('dt-macd');
  if (!canvas) return;
  const W = canvas.width = canvas.clientWidth || 380;
  const H = canvas.height = Math.round(Math.min(170, Math.max(100, W * 0.24)));
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.font = '9px Inter,system-ui';

  const d = MACD_TF[tf] ? _macdData.get(sym + '|' + tf) : null;
  if (!d || !d.m) {
    ctx.fillStyle = '#c8d0dc'; ctx.textAlign = 'left';
    ctx.fillText(MACD_TF[tf] ? `MACD ${tf}: cargando…` : `MACD: solo en ${MACD_TFS.join(' y ')} — cambia la temporalidad arriba`, PADL + 4, 14);
    return;
  }
  const idx = new Map(k.t.map((t, j) => [t, j]));
  const puntos = [];
  for (let i = 0; i < d.n; i++) {
    const j = idx.get(d.t[i]);
    if (j != null && j >= start) puntos.push({ i, j });
  }
  if (!puntos.length) return;

  let min = 0, max = 0;
  for (const { i } of puntos) {
    min = Math.min(min, d.m.macd[i], d.m.sig[i], d.m.hist[i]);
    max = Math.max(max, d.m.macd[i], d.m.sig[i], d.m.hist[i]);
  }
  const rango = (max - min) || 1;
  const PADV = 12;
  const x = j => PADL + (j - start) / Math.max(1, N - 1 + RGAP) * (W - PADL - PADR);
  const y = v => PADV + (max - v) / rango * (H - 2 * PADV);
  const bw = Math.max(1, (W - PADL - PADR) / N * 0.62);

  ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PADL, y(0)); ctx.lineTo(W - PADR, y(0)); ctx.stroke();

  for (const { i, j } of puntos) {
    const h = d.m.hist[i], prev = d.m.hist[i - 1] ?? h;
    ctx.fillStyle = h >= 0 ? (h >= prev ? '#00d98b' : '#a8f0d0') : (h <= prev ? '#ff1744' : '#ffb3c1');
    const y0 = y(0), y1 = y(h);
    ctx.fillRect(x(j) - bw / 2, Math.min(y0, y1), bw, Math.max(1, Math.abs(y1 - y0)));
  }
  const linea = (serie, col) => {
    ctx.strokeStyle = col; ctx.lineWidth = 1.2;
    ctx.beginPath();
    puntos.forEach(({ i, j }, n) => { const px = x(j), py = y(serie[i]); if (n) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
    ctx.stroke();
  };
  linea(d.m.sig, '#ff8a3c');
  linea(d.m.macd, '#4f8dff');

  const estilo = {
    L:   ['#00d98b', '#04241a', 'L'], S:  ['#ff1744', '#ffffff', 'S'],
    PBR: ['#ffb3c1', '#5a0a1e', 'PB'], PBV: ['#a8f0d0', '#06382a', 'PB'],
    UP:  ['#00d98b', '#04241a', '▲'], DN: ['#ff1744', '#ffffff', '▼'],
  };
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const jDe = new Map(puntos.map(p => [p.i, p.j]));
  for (const ev of d.eventos) {
    const j = jDe.get(ev.i);
    if (j == null) continue;
    const [bg, fg, txt] = estilo[ev.tipo];
    const px = x(j);
    const py = Math.min(H - 7, Math.max(7, (ev.tipo === 'UP' || ev.tipo === 'DN') ? y(0) : y(d.m.macd[ev.i])));
    const w = txt === 'PB' ? 14 : 10;
    ctx.fillStyle = bg;
    ctx.fillRect(px - w / 2, py - 5, w, 10);
    ctx.fillStyle = fg;
    ctx.fillText(txt, px, py + 0.5);
  }
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  ctx.fillStyle = '#c8d0dc';
  ctx.fillText(`MACD 15·26·34 · ${tf}`, PADL + 4, 9);
}
