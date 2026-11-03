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
 * Objetivo: cobrar 5% a 10x, o sea 0,5% de precio. El usuario no definió stop, así
 * que el seguimiento mide en paralelo dos salidas sobre cada L/S:
 *   · objetivo o, si no llega, cruce contrario de la señal
 *   · sin stop: objetivo o LIQUIDACIÓN (−9,5% de precio a 10x), con un plazo de 7 días
 * Medido en 100 monedas y un mes (5m): sin stop llega el 94% y aun así pierde
 * −1,29% de margen por operación, porque cada liquidación borra 24 ganadoras. Con
 * el cruce contrario llega el 44% (haría falta el 56%) y pierde −1,18%. Una
 * entrada al azar con la misma salida da lo mismo: la pérdida es casi toda la
 * comisión, que a 10x son 0,85-1,30% del margen en cada vuelta.
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
 * Una moneda que sale del universo se sigue hasta cerrar sus operaciones.
 *
 * Los resultados se guardan como TOTALES por temporalidad, señal y semana, no como
 * lista: los seguimientos por lista se recortaban solos al llenarse el
 * almacenamiento (el comparador conservaba unas horas y W/M tres días).
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
const MACD_LIQ_PCT    = 9.5;    // a 10x, esto en contra liquida (margen de mantenimiento incluido)
const MACD_FEE_TP     = 0.085;  // % de precio: entrada a mercado 0,065 + objetivo limite 0,02
const MACD_FEE_MKT    = 0.13;   // % de precio: entrada y salida a mercado
const MACD_PLAZO_MS   = 7 * 864e5; // la salida sin stop se da por terminada a los 7 días
const MACD_VELAS      = 200;
const MACD_WARMUP     = 120;    // antes de esta vela el EMA aún arrastra su valor inicial
const MACD_MIN_VELAS  = 70;     // moneda recién listada: menos que esto no da un MACD fiable
const MACD_MARGEN_MS  = 6_000;  // tras el cierre, tiempo que tiene el WebSocket antes de descargar
const MACD_RAFAGA_MS  = 400;    // las monedas de un mismo cierre llegan juntas: un solo aviso
const MACD_MAX_VELAS  = 260;    // con el WebSocket la serie crece; se recorta a MACD_VELAS
const MACD_WORKERS    = 5;
const MACD_MAX_LOTE   = 120;    // peticiones como mucho por tanda
const MACD_REVISAR_MS = 2_000;  // cada cuánto se mira si ha cerrado una vela (en 5m importa)
const MACD_FRESCA     = 3;      // velas que una L/S sigue en la tira
const MACD_STRIP_MAX  = 16;
const MACD_RECIENTES  = 40;     // operaciones terminadas por TF que se conservan en detalle
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

const _macdStoreVacio = () => ({ v: 2, desde: Date.now(), marcas: {}, abiertas: [], recientes: { '5m': [], '15m': [] }, agg: {} });
let _macdStore = (() => {
  try {
    const s = JSON.parse(localStorage.getItem('scalp_macd') || 'null');
    if (s && s.v === 2) return s;
  } catch (_) { /* dato roto: se empieza de cero */ }
  return _macdStoreVacio();
})();
let _macdSucio = false;

// Dos pestañas abiertas no deben contar lo mismo dos veces: la que guarda avisa
// a la otra, que adopta los totales y las marcas de vela procesada.
window.addEventListener('storage', e => {
  if (e.key !== 'scalp_macd' || !e.newValue) return;
  try { const s = JSON.parse(e.newValue); if (s && s.v === 2) _macdStore = s; } catch (_) { /* se ignora */ }
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

function macdCalcular(cierres) {
  const r = _macdEma(cierres, MACD_FAST), l = _macdEma(cierres, MACD_SLOW);
  const macd = cierres.map((_, i) => r[i] - l[i]);
  const sig = _macdEma(macd, MACD_SIGNAL);
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
  for (const t of _macdStore.abiertas) if (out[t.f]) out[t.f].add(t.s);
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
  if (typeof safeSetItem === 'function') safeSetItem('scalp_macd', JSON.stringify(_macdStore));
}

// ── Seguimiento ─────────────────────────────────────────────────────────────
function _macdSemana(ts) {
  const d = new Date(ts);
  return new Date(ts - ((d.getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10);
}

// agg[tf|señal|semana], todo en % de PRECIO (el margen se calcula al pintar):
// [nA, aciertosA, sumaNetoA, sumaNeto²A, minutosA, sumaMAE, sumaMFE,
//  nB, aciertosB, sumaNetoB, sumaNeto²B, minutosB, objetivosA, objetivosB, liquidadasB]
const _MACD_R4 = v => Math.round(v * 1e4) / 1e4;
function _macdAcumular(t, salida, netoPct, minutos, motivo) {
  const key = `${t.f}|${t.k}|${_macdSemana(t.ts)}`;
  const a = _macdStore.agg[key] || (_macdStore.agg[key] = new Array(15).fill(0));
  const o = salida === 'a' ? 0 : 7;
  a[o]     += 1;
  a[o + 1] += netoPct > 0 ? 1 : 0;
  a[o + 2]  = _MACD_R4(a[o + 2] + netoPct);
  a[o + 3]  = _MACD_R4(a[o + 3] + netoPct * netoPct);
  a[o + 4]  = Math.round(a[o + 4] + minutos);
  if (salida === 'a') { a[5] = _MACD_R4(a[5] + t.mn); a[6] = _MACD_R4(a[6] + t.mx); }
  if (motivo === 'T') a[salida === 'a' ? 12 : 13] += 1;
  if (motivo === 'X') a[14] += 1;
}

// Neto en % de precio. Liquidada: se pierde todo el margen, aunque el precio
// solo se haya movido un 9,5%. T = objetivo · C = cruce · X = liquidada · H = plazo.
function _macdNetoSalida(t, px, motivo) {
  if (motivo === 'X') return -100 / MACD_LEV;
  return t.d * (px / t.e - 1) * 100 - (motivo === 'T' ? MACD_FEE_TP : MACD_FEE_MKT);
}

function _macdCerrarSalida(t, salida, ts, px, motivo) {
  t[salida] = [ts, px, motivo];
  _macdAcumular(t, salida, _macdNetoSalida(t, px, motivo), (ts - t.ts) / 60_000, motivo);
}

function _macdProcesar(sym, tf, d) {
  const key = sym + '|' + tf, ms = MACD_TF[tf].ms;
  const marca = _macdStore.marcas[key] || 0;
  let inicio = d.desde;
  while (inicio < d.n && d.t[inicio] <= marca) inicio++;
  if (inicio >= d.n) return;

  const abiertas = _macdStore.abiertas.filter(t => t.s === sym && t.f === tf);
  for (let i = inicio; i < d.n; i++) {
    const ev = macdEventos(d.m, i);
    const px = d.o[i + 1] ?? d.c[i];             // al abrir la vela siguiente
    const ts = d.t[i] + ms;
    const cruceUp = d.m.hist[i - 1] <= 0 && d.m.hist[i] > 0;
    const cruceDn = d.m.hist[i - 1] >= 0 && d.m.hist[i] < 0;

    for (const t of abiertas) {
      if (t.a && t.b) continue;
      if (d.t[i] < t.ts) continue;               // la operación aún no había entrado
      const fav = t.d > 0 ? (d.h[i] / t.e - 1) * 100 : (1 - d.l[i] / t.e) * 100;
      const con = t.d > 0 ? (d.l[i] / t.e - 1) * 100 : (1 - d.h[i] / t.e) * 100;
      const objetivo = t.e * (1 + t.d * MACD_TP_PCT / 100);
      if (!t.a) {
        t.mx = _MACD_R4(Math.max(t.mx, fav));
        t.mn = _MACD_R4(Math.min(t.mn, con));
        // El objetivo se toca durante la vela y el cruce se confirma al cerrarla.
        if (fav >= MACD_TP_PCT) _macdCerrarSalida(t, 'a', ts, objetivo, 'T');
        else if (t.d > 0 ? cruceDn : cruceUp) _macdCerrarSalida(t, 'a', ts, px, 'C');
      }
      if (!t.b) {
        // Si en la misma vela caben las dos, se supone la liquidación: la peor.
        if (con <= -MACD_LIQ_PCT) _macdCerrarSalida(t, 'b', ts, t.e * (1 - t.d * MACD_LIQ_PCT / 100), 'X');
        else if (fav >= MACD_TP_PCT) _macdCerrarSalida(t, 'b', ts, objetivo, 'T');
        else if (ts - t.ts >= MACD_PLAZO_MS) _macdCerrarSalida(t, 'b', ts, d.c[i], 'H');
      }
    }

    for (const tipo of ev) {
      if (!(tipo in MACD_ENTRADAS)) continue;
      const nueva = { s: sym, f: tf, k: tipo, d: MACD_ENTRADAS[tipo], ts, e: px, a: null, b: null, mx: 0, mn: 0 };
      abiertas.push(nueva);
      _macdStore.abiertas.push(nueva);
      if (i === d.n - 1 && Date.now() - ts < MACD_AVISO_MAX_MS) _macdAvisos[tf][tipo].push({ sym, px });
    }
  }
  _macdStore.marcas[key] = d.t[d.n - 1];

  // Las que ya tienen las dos salidas pasan a recientes.
  const cerradas = _macdStore.abiertas.filter(t => t.s === sym && t.f === tf && t.a && t.b);
  if (cerradas.length) {
    _macdStore.abiertas = _macdStore.abiertas.filter(t => !(t.s === sym && t.f === tf && t.a && t.b));
    const rec = _macdStore.recientes[tf];
    rec.push(...cerradas);
    if (rec.length > MACD_RECIENTES) rec.splice(0, rec.length - MACD_RECIENTES);
  }
  _macdSucio = true;
}

function _macdTrasLote() {
  const now = Date.now();
  for (const k of Object.keys(_macdStore.marcas)) {
    if (now - _macdStore.marcas[k] > MACD_MARCA_MAX_MS) delete _macdStore.marcas[k];
  }
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
  const info = ev => ev && { tipo: ev.tipo, velas: ult - ev.i, cierre: d.t[ev.i] + ms, ref: d.o[ev.i + 1] ?? d.c[ev.i] };
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
  if (typeof activeTab !== 'undefined' && activeTab === 'lab') renderMacdPanel();
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

// La operación de esa señal, para saber si ya cobró o sigue viva.
function _macdOperacion(sym, tf, ls) {
  const es = t => t.s === sym && t.ts === ls.cierre && t.k === ls.tipo;
  return _macdStore.abiertas.find(es) || (_macdStore.recientes[tf] || []).find(es) || null;
}

// Lo reciente se lee en minutos, y lo que acaba de pasar no es "hace 0m".
function _macdHace(ms) { return ms < 60_000 ? 'ahora' : patAgo(ms).replace('hace ', ''); }

function _macdTextoMargen(tipo, ref, precio, op) {
  if (op && op.a) {
    if (op.a[2] === 'T') return `<b style="color:#2fe08a" title="Ya tocó el objetivo: entrar ahora sería llegar tarde">🎯 cobrada</b>`;
    return `<span style="color:#8b9098" title="El MACD ya se dio la vuelta sin llegar al objetivo">cruce</span>`;
  }
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
      <span style="color:#8b9098">${_macdHace(Date.now() - ls.cierre)}</span>
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
    if (!r) return `<div class="dt-row"><span>${tf}</span><b style="color:#8b9098">cargando…</b></div>`;
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
    ctx.fillStyle = '#8b9098'; ctx.textAlign = 'left';
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
  ctx.fillStyle = '#8b9098';
  ctx.fillText(`MACD 15·26·34 · ${tf}`, PADL + 4, 9);
}

// ── Panel del Lab ───────────────────────────────────────────────────────────
function _macdTotales(tf, k) {
  const t = new Array(15).fill(0);
  const pre = `${tf}|${k}|`;
  for (const key of Object.keys(_macdStore.agg)) {
    if (!key.startsWith(pre)) continue;
    _macdStore.agg[key].forEach((v, i) => { t[i] += v; });
  }
  return t;
}

// Neto medio sobre margen, con su margen de error al 95%: sin él, una media de
// pocas operaciones parece una conclusión. s y q llegan en % de precio.
function _macdCeldaNeto(n, s, q, extra) {
  if (!n) return '<td style="color:#8b9098">—</td>';
  const m = s / n * MACD_LEV;
  const e = n > 1 ? 1.96 * Math.sqrt(Math.max(0, q / n - (s / n) ** 2)) / Math.sqrt(n) * MACD_LEV : null;
  const col = e != null && m - e > 0 ? '#2fe08a' : e != null && m + e < 0 ? '#ff6680' : '#d7dde8';
  return `<td style="color:${col}" title="Verde o rojo solo si el margen de error no toca el 0.">${m >= 0 ? '+' : ''}${m.toFixed(2)}%${e != null ? ` <span style="opacity:.6">±${e.toFixed(2)}</span>` : ''}${extra || ''}</td>`;
}

const _macdFmtSalida = { T: '🎯 objetivo', C: 'cruce', X: '💀 liquidada', H: 'plazo' };

// Abiertas de cada salida. Las de "sin stop" importan especialmente: solo cuentan al
// resolverse y las que van perdiendo siguen abiertas, así que sin este número el
// acierto de esa columna parecería mejor de lo que es.
function _macdAbiertasTxt(filtro) {
  const a = _macdStore.abiertas.filter(filtro);
  return `${a.filter(t => !t.a).length} · ${a.filter(t => !t.b).length}`;
}

function renderMacdPanel() {
  const el = document.getElementById('lab-macd');
  if (!el) return;
  const NOMBRE = { L: 'L · long', S: 'S · short' };
  const fila = (nombre, col, a, abiertas) => `<tr>
    <td style="color:${col}">${nombre}</td>
    <td>${a[0]}</td>
    <td title="Tocan el objetivo antes del cruce contrario">${a[0] ? Math.round(a[12] / a[0] * 100) + '%' : '—'}</td>
    ${_macdCeldaNeto(a[0], a[2], a[3])}
    <td title="Sin stop, tocan el objetivo antes de liquidarse">${a[7] ? (a[13] / a[7] * 100).toFixed(0) + '%' : '—'}</td>
    <td style="color:${a[14] ? '#ff6680' : '#a5adb7'}">${a[14]}</td>
    ${_macdCeldaNeto(a[7], a[9], a[10])}
    <td style="color:#a5adb7">${a[0] ? fmtDur(a[4] / a[0] * 60_000) : '—'}</td>
    <td style="color:#a5adb7">${a[7] ? fmtDur(a[11] / a[7] * 60_000) : '—'}</td>
    <td style="color:#ff9a9a">${a[0] ? (a[5] / a[0] * MACD_LEV).toFixed(1) + '%' : '—'}</td>
    <td style="color:#a5adb7">${abiertas}</td>
  </tr>`;
  const filas = MACD_TFS.map(tf => {
    const tot = new Array(15).fill(0);
    const cuerpo = Object.keys(NOMBRE).map(k => {
      const a = _macdTotales(tf, k);
      a.forEach((v, i) => { tot[i] += v; });
      return fila(NOMBRE[k], MACD_ENTRADAS[k] > 0 ? '#2fe08a' : '#ff6680', a, _macdAbiertasTxt(t => t.f === tf && t.k === k));
    }).join('');
    return `<tr class="patt-tf-row"><td colspan="11">◭ ${tf}</td></tr>${cuerpo}${fila('Total', '#eef2fa', tot, _macdAbiertasTxt(t => t.f === tf))}`;
  }).join('');

  const tf = macdTfVista;
  const precioDe = typeof allRows !== 'undefined' ? new Map(allRows.map(r => [r.symbol, r.price])) : new Map();
  const abiertas = _macdStore.abiertas.filter(t => t.f === tf && !t.a).sort((a, b) => b.ts - a.ts).slice(0, 12);
  const filasAb = abiertas.map(t => {
    const px = precioDe.get(t.s);
    const m = px ? _macdMargen(t.k, t.e, px) : null;
    return `<tr><td class="pt-sym">${t.s}</td><td style="color:${t.d > 0 ? '#2fe08a' : '#ff6680'}">${MACD_ETIQUETA[t.k]}</td>
      <td style="color:#b3bcc9">${fmtPrice(t.e)}</td><td style="color:#8090b0">${px ? fmtPrice(px) : '—'}</td>
      <td class="${m == null ? '' : m >= 0 ? 'pt-pnl-pos' : 'pt-pnl-neg'}">${m == null ? '—' : (m >= 0 ? '+' : '') + m.toFixed(1) + '%'}</td>
      <td style="color:#a5adb7">${fmtDur(Date.now() - t.ts)}</td></tr>`;
  }).join('') || '<tr><td colspan="6" class="pt-empty">Sin operaciones abiertas en esta temporalidad</td></tr>';
  // Terminadas con la salida principal, aunque la de "sin stop" siga viva.
  const terminadas = [..._macdStore.recientes[tf], ..._macdStore.abiertas.filter(t => t.f === tf && t.a)]
    .sort((x, y) => y.a[0] - x.a[0]).slice(0, 12);
  const filasRec = terminadas.map(t => {
    const m = _macdNetoSalida(t, t.a[1], t.a[2]) * MACD_LEV;
    return `<tr><td class="pt-sym">${t.s}</td><td style="color:${t.d > 0 ? '#2fe08a' : '#ff6680'}">${MACD_ETIQUETA[t.k]}</td>
      <td style="color:#b3bcc9">${fmtPrice(t.e)}</td><td style="color:#8090b0">${_macdFmtSalida[t.a[2]] || ''}</td>
      <td class="${m >= 0 ? 'pt-pnl-pos' : 'pt-pnl-neg'}">${m >= 0 ? '+' : ''}${m.toFixed(1)}%</td>
      <td style="color:#a5adb7">${fmtDur(t.a[0] - t.ts)}</td></tr>`;
  }).join('') || '<tr><td colspan="6" class="pt-empty">Sin operaciones terminadas todavía</td></tr>';

  const btns = MACD_TFS.map(t => `<button class="chart-tf-btn${t === tf ? ' active' : ''}" onclick="setMacdTf('${t}')">${t}</button>`).join('');
  el.innerHTML = `
    <div class="pt-header">
      <span class="pt-title">📊 MACD 15·26·34 — scalp: objetivo 5% a ${MACD_LEV}x</span>
      <button class="pt-btn" onclick="exportMacdTrack()" title="Descargar los totales y las operaciones en JSON">Exportar JSON</button>
      <button class="pt-btn pt-btn-danger" onclick="clearMacdTrack()">Limpiar</button>
    </div>
    <div style="padding:6px 10px;font-size:9px;color:#aab3c1;border-bottom:1px solid #141e2e">
      Todo en <b style="color:#eef2fa">% sobre margen a ${MACD_LEV}x</b>, neto de comisión (a ${MACD_LEV}x son 0,85% del margen si llega al objetivo y 1,30% si no). Entrada al abrir la vela siguiente a la L o S; objetivo: ${MACD_TP_PCT.toString().replace('.', ',')}% de precio. Sin stop definido se miden dos salidas en paralelo: <b style="color:#eef2fa">objetivo o cruce contrario</b>, y <b style="color:#eef2fa">sin stop</b>, hasta el objetivo o la liquidación (−${MACD_LIQ_PCT.toString().replace('.', ',')}% de precio, se pierde todo el margen). Datos desde el ${new Date(_macdStore.desde).toISOString().slice(0, 10)}, con hasta 80 velas hacia atrás (6,7h en 5m, 20h en 15m). Si cierras la pestaña, al volver recupera lo perdido dentro de ese mismo margen. <b style="color:#ffbe3c">Ojo:</b> "sin stop" solo cuenta lo ya resuelto; las que van perdiendo siguen abiertas, así que con pocos días sale mejor de lo que es.
    </div>
    <table class="pt-table">
      <thead><tr><th>Señal</th><th>Operaciones</th><th>Llegan</th><th>Neto: objetivo o cruce</th><th>Sin stop: llegan</th><th>Liquidadas</th><th>Neto: sin stop</th><th>Dura (cruce)</th><th>Dura (sin stop)</th><th title="Lo peor que fue en contra de media antes de salir por objetivo o cruce">Peor en contra</th><th title="Operaciones aún sin resolver en cada salida. Las de sin stop que van perdiendo siguen aquí sin contar en su acierto: al principio esa columna sale mejor de lo que es.">Abiertas: cruce · sin stop</th></tr></thead>
      <tbody>${filas}</tbody>
    </table>
    <div class="pt-section" style="display:flex;align-items:center;gap:6px">Operaciones en ${btns}</div>
    <div class="macd-tablas">
      <div><table class="pt-table">
        <thead><tr><th>Abiertas</th><th></th><th>Entrada</th><th>Actual</th><th>A ${MACD_LEV}x</th><th>Tiempo</th></tr></thead>
        <tbody>${filasAb}</tbody>
      </table></div>
      <div><table class="pt-table">
        <thead><tr><th>Terminadas</th><th></th><th>Entrada</th><th>Salida</th><th>Neto a ${MACD_LEV}x</th><th>Duración</th></tr></thead>
        <tbody>${filasRec}</tbody>
      </table></div>
    </div>`;
}

function exportMacdTrack() {
  const datos = {
    exportadoEl: new Date().toISOString(),
    origen: location.origin,
    reglas: {
      macd: { rapida: MACD_FAST, lenta: MACD_SLOW, senal: MACD_SIGNAL, fuente: 'cierre', medias: 'EMA' },
      entrada: 'apertura de la vela siguiente a la L o S',
      apalancamiento: MACD_LEV,
      objetivoPrecioPct: MACD_TP_PCT,
      salidaA: 'objetivo o cruce contrario de la señal',
      salidaB: 'sin stop: objetivo, liquidación o plazo de 7 días',
      liquidacionPrecioPct: MACD_LIQ_PCT,
      comisionPrecioPct: { conObjetivo: MACD_FEE_TP, aMercado: MACD_FEE_MKT },
      columnasAgg: ['nA', 'aciertosA', 'sumaNetoA', 'sumaNeto2A', 'minutosA', 'sumaMAE', 'sumaMFE', 'nB', 'aciertosB', 'sumaNetoB', 'sumaNeto2B', 'minutosB', 'objetivosA', 'objetivosB', 'liquidadasB'],
      unidadesAgg: '% de precio; multiplicar por el apalancamiento para ver el margen',
    },
    ..._macdStore,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(datos, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `macd-${location.hostname}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function clearMacdTrack() {
  if (!confirm('¿Borrar todo el seguimiento del MACD?')) return;
  // Las marcas se conservan: si no, las velas ya vistas se volverían a contar.
  _macdStore = { ..._macdStoreVacio(), marcas: _macdStore.marcas };
  _macdSucio = true;
  _macdGuardar();
  renderMacdPanel();
}
