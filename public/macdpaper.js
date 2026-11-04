/* public/macdpaper.js
 * 🧪 PAPER TRADING del MACD, para ir ajustando la estrategia.
 *
 * Una VARIANTE es un juego de reglas: temporalidad, objetivo, stop, cruce contrario,
 * apalancamiento, dirección, tipo de entrada, comisión y periodos del MACD. Todas
 * corren a la vez sobre las mismas velas, así que para probar un ajuste no hay que
 * esperar otra semana: se crea una variante nueva y la original sigue al lado. Las
 * reglas de una variante no se editan, porque mezclaría resultados de reglas
 * distintas; ✏️ crea otra a partir de ella.
 *
 * Cómo se simula cada vela cerrada:
 *   · A mercado se entra al abrir la vela siguiente a la señal, y paga taker más
 *     deslizamiento. El objetivo es una orden límite y paga maker.
 *   · Con entrada límite la orden se pone en el cierre de la señal y vale una vela.
 *     Si el precio no la cruza, esa señal no se opera. En la vela en que se llena solo
 *     cuenta lo malo (stop, liquidación), porque no se sabe qué pasó antes.
 *   · Si en una vela caben stop y objetivo se supone lo peor, el stop. En 15m antes se
 *     miran sus velas de 5m para ver cuál tocó primero: suponer siempre lo peor marcaba
 *     −1,64 por operación donde las velas de 1m dan −1,17. Si el precio abre más allá
 *     del stop, se sale a esa apertura.
 *   · Sin stop, la operación llega hasta el objetivo o la liquidación (se pierde todo
 *     el margen), con un plazo de 7 días.
 *   · Una operación por moneda y variante, como en una cuenta real: una señal con
 *     posición abierta se salta y se cuenta aparte.
 *
 * Cada operación usa $100 de margen, así que +$5 equivale a +5% sobre margen. No
 * incluye funding, que pesa poco en operaciones cortas pero sí en las de varios días.
 *
 * Corre en el navegador: solo avanza con el screener abierto, pero al volver pide las
 * velas que faltan, hasta 1000: recupera señales y resuelve las operaciones abiertas de
 * hasta 3 días en 5m y 9 en 15m. Si faltan más no se puede saber qué pasó: esas
 * operaciones se anulan en lugar de inventar un resultado.
 *
 * Se guardan totales, una serie por horas y las últimas operaciones, no la lista
 * entera: los seguimientos por lista se recortaban solos al llenarse el almacenamiento.
 */

const PAPER_MARGEN    = 100;       // $ de margen por operación: +$5 = +5%
const PAPER_SLIP      = 0.01;      // % de precio por lado a mercado
const PAPER_MMR       = 0.5;       // margen de mantenimiento: a 10x liquida a −9,5%
const PAPER_PLAZO_MS  = 7 * 864e5;
const PAPER_CERRADAS  = 60;        // operaciones terminadas que se conservan por variante
const PAPER_SERIE_MAX = 200;       // puntos de la curva: al pasarse, cada punto vale el doble de horas
const PAPER_MAX_VARIANTES = 12;
const PAPER_BASE = {
  tf: '5m', dir: 'ambas', lev: 10, tp: 5, sl: 0, cruce: true, entrada: 'mercado',
  taker: 0.055, maker: 0.02, fast: MACD_FAST, slow: MACD_SLOW, signal: MACD_SIGNAL, azar: false,
};
const PAPER_FORM = { ...PAPER_BASE, sl: 5, cruce: false };   // una variante nueva parte de la regla con su stop
const PAPER_MOTIVO = { T: '🎯 objetivo', P: '🛑 stop', C: 'cruce', X: '💀 liquidada', H: 'plazo' };

const _paperR = v => Math.round(v * 1e4) / 1e4;
const _paperTotVacio = () => ({
  n: 0, g: 0, neto: 0, neto2: 0, ganado: 0, perdido: 0, mae: 0, mfe: 0, min: 0,
  mot: { T: 0, P: 0, C: 0, X: 0, H: 0 }, L: [0, 0, 0], S: [0, 0, 0],
  saltadas: 0, sinLlenar: 0, anuladas: 0,
});

let _paperContador = 0;
function _paperNueva(nombre, cfg) {
  return {
    id: `v${Date.now().toString(36)}${(_paperContador++).toString(36)}`,
    nombre, cfg: { ...PAPER_BASE, ...cfg }, desde: Date.now(),
    abiertas: [], cerradas: [], tot: _paperTotVacio(), serie: {}, ancho: 1,
  };
}

// De partida: la regla del usuario con su stop, otras salidas de referencia y un control.
// El control entra en las mismas señales con dirección al azar: si una variante no le
// gana, la señal no está aportando nada.
const _paperIniciales = () => [
  ['5m · 5% con stop 5%', { tf: '5m', sl: 5, cruce: false }],
  ['5m · 5% o cruce', { tf: '5m', cruce: true }],
  ['5m · 5% sin stop', { tf: '5m', cruce: false }],
  ['5m · control al azar', { tf: '5m', cruce: true, azar: true }],
  ['15m · 5% con stop 5%', { tf: '15m', sl: 5, cruce: false }],
  ['15m · 5% o cruce', { tf: '15m', cruce: true }],
  ['15m · 5% sin stop', { tf: '15m', cruce: false }],
].map(([n, c]) => _paperNueva(n, c));

if (!Array.isArray(_macdStore.variantes)) _macdStore.variantes = _paperIniciales();

// ── Motor ───────────────────────────────────────────────────────────────────
// Dirección del control: repetible por moneda y vela, para que dos pestañas y una
// recarga den lo mismo.
function _paperAzar(sym, ts) {
  let h = 2166136261;
  for (const ch of sym + ts) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return h & 1 ? 1 : -1;
}

function _paperMacd(c, d) {
  if (c.fast === MACD_FAST && c.slow === MACD_SLOW && c.signal === MACD_SIGNAL) return d.m;
  const k = `${c.fast}|${c.slow}|${c.signal}`;
  const cache = d.mOtros || (d.mOtros = {});
  return cache[k] || (cache[k] = macdCalcular(d.c.slice(0, d.n), c.fast, c.slow, c.signal));
}

// % de precio de ida y vuelta. La salida al objetivo es límite; las demás, a mercado.
function _paperComision(c, esObjetivo) {
  const mercado = c.taker + PAPER_SLIP;
  return (c.entrada === 'limite' ? c.maker : mercado) + (esObjetivo ? c.maker : mercado);
}

// Neto en % de margen. Nunca se pierde más que el margen.
function _paperNeto(c, t, px, motivo) {
  if (motivo === 'X') return -100;
  return Math.max(-100, (t.d * (px / t.e - 1) * 100 - _paperComision(c, motivo === 'T')) * c.lev);
}

function _paperSerie(v, ts, neto) {
  const k = Math.floor(ts / (36e5 * v.ancho));
  v.serie[k] = _paperR((v.serie[k] || 0) + neto);
  if (Object.keys(v.serie).length <= PAPER_SERIE_MAX) return;
  const nueva = {};
  for (const [a, x] of Object.entries(v.serie)) {
    const b = Math.floor(a / 2);
    nueva[b] = _paperR((nueva[b] || 0) + x);
  }
  v.serie = nueva;
  v.ancho *= 2;
}

function _paperCerrar(v, t, ts, px, motivo) {
  const c = v.cfg, a = v.tot, neto = _paperNeto(c, t, px, motivo);
  a.n++;
  if (neto > 0) { a.g++; a.ganado = _paperR(a.ganado + neto); } else a.perdido = _paperR(a.perdido + neto);
  a.neto = _paperR(a.neto + neto);
  a.neto2 = _paperR(a.neto2 + neto * neto);
  a.mae = _paperR(a.mae + t.mn * c.lev);
  a.mfe = _paperR(a.mfe + t.mx * c.lev);
  a.min = Math.round(a.min + (ts - t.ts) / 60_000);
  a.mot[motivo]++;
  const lado = a[t.k];
  lado[0]++;
  if (neto > 0) lado[1]++;
  lado[2] = _paperR(lado[2] + neto);
  v.abiertas.splice(v.abiertas.indexOf(t), 1);
  v.cerradas.push({ s: t.s, k: t.k, ts: t.ts, e: t.e, xt: ts, x: px, mo: motivo, n: _paperR(neto) });
  if (v.cerradas.length > PAPER_CERRADAS) v.cerradas.splice(0, v.cerradas.length - PAPER_CERRADAS);
  _paperSerie(v, ts, neto);
}

// Stop y objetivo caben en la vela: ¿tocó antes el objetivo? Se mira en las velas de 5m de
// esa moneda. Sin ellas, o si en una de 5m también caben los dos, se supone que no.
function _paperObjetivoAntes(t, inicio, ms, stop, objetivo) {
  const d5 = _macdData.get(t.s + '|5m');
  if (!d5 || !d5.n) return false;
  let a = 0, b = d5.n;
  while (a < b) { const k = (a + b) >> 1; if (d5.t[k] < inicio) a = k + 1; else b = k; }
  for (let k = a; k < d5.n && d5.t[k] < inicio + ms; k++) {
    const fav = t.d > 0 ? (d5.h[k] / t.e - 1) * 100 : (1 - d5.l[k] / t.e) * 100;
    const con = t.d > 0 ? (d5.l[k] / t.e - 1) * 100 : (1 - d5.h[k] / t.e) * 100;
    if (con <= -stop) return false;
    if (fav >= objetivo) return true;
  }
  return false;
}

// Qué le pasa a la operación en la vela i: { px, mo } si sale, o null.
function _paperSalida(c, t, d, m, i, ms, recienLlenada) {
  const fav = t.d > 0 ? (d.h[i] / t.e - 1) * 100 : (1 - d.l[i] / t.e) * 100;
  const con = t.d > 0 ? (d.l[i] / t.e - 1) * 100 : (1 - d.h[i] / t.e) * 100;
  if (!recienLlenada) t.mx = _paperR(Math.max(t.mx, fav));
  t.mn = _paperR(Math.min(t.mn, con));

  const precio = pct => t.e * (1 + t.d * pct / 100);
  const liq = 100 / c.lev - PAPER_MMR;
  const stop = c.sl > 0 ? c.sl / c.lev : 0;
  const objetivo = c.tp > 0 ? c.tp / c.lev : 0;

  if (stop && stop < liq && con <= -stop) {
    if (objetivo && !recienLlenada && fav >= objetivo && _paperObjetivoAntes(t, d.t[i], ms, stop, objetivo)) {
      return { px: precio(objetivo), mo: 'T' };
    }
    const px = precio(-stop);
    return { px: t.d > 0 ? Math.min(px, d.o[i]) : Math.max(px, d.o[i]), mo: 'P' };
  }
  if (con <= -liq) return { px: precio(-liq), mo: 'X' };
  if (objetivo && !recienLlenada && fav >= objetivo) return { px: precio(objetivo), mo: 'T' };
  const h = m.hist;
  const contrario = t.d > 0 ? h[i - 1] >= 0 && h[i] < 0 : h[i - 1] <= 0 && h[i] > 0;
  if (c.cruce && contrario) return { px: d.o[i + 1] ?? d.c[i], mo: 'C' };
  if (d.t[i] + ms - t.ts >= PAPER_PLAZO_MS) return { px: d.c[i], mo: 'H' };
  return null;
}

function _paperVela(v, sym, d, m, i, ms, puedeEntrar) {
  const c = v.cfg, cierre = d.t[i] + ms;
  let t = v.abiertas.find(x => x.s === sym) || null, recienLlenada = false;

  if (t && t.pend) {
    // Tiene que cruzar el precio, no solo tocarlo: la vela siguiente abre casi siempre
    // en el cierre anterior, y con tocar se llenarían todas, incluidas las que se van
    // a favor sin volver, que en la realidad se quedan sin entrar.
    if (t.d > 0 ? d.l[i] < t.e : d.h[i] > t.e) {
      delete t.pend;
      t.ts = d.t[i];
      recienLlenada = true;
    } else {
      v.abiertas.splice(v.abiertas.indexOf(t), 1);
      v.tot.sinLlenar++;
      t = null;
    }
  }
  if (t && d.t[i] >= t.ts) {
    const s = _paperSalida(c, t, d, m, i, ms, recienLlenada);
    if (s) { _paperCerrar(v, t, cierre, s.px, s.mo); t = null; }
  }
  if (!puedeEntrar) return;

  for (const tipo of macdEventos(m, i)) {
    if (!(tipo in MACD_ENTRADAS)) continue;
    const dir = c.azar ? _paperAzar(sym, cierre) : MACD_ENTRADAS[tipo];
    if ((c.dir === 'L' && dir < 0) || (c.dir === 'S' && dir > 0)) continue;
    if (t) { v.tot.saltadas++; continue; }
    const limite = c.entrada === 'limite';
    t = { s: sym, k: dir > 0 ? 'L' : 'S', d: dir, ts: cierre, e: limite ? d.c[i] : (d.o[i + 1] ?? d.c[i]), mx: 0, mn: 0 };
    if (limite) t.pend = true;
    v.abiertas.push(t);
  }
}

function _paperCorrer(v, sym, d, inicio) {
  const m = _paperMacd(v.cfg, d), ms = MACD_TF[v.cfg.tf].ms;
  for (let i = Math.max(1, inicio); i < d.n; i++) _paperVela(v, sym, d, m, i, ms, i >= d.desde);
}

// Desde macd.js con las velas nuevas de una moneda.
function paperProcesar(sym, tf, d, marca) {
  const ms = MACD_TF[tf].ms;
  let inicio = 1;
  while (inicio < d.n && d.t[inicio] <= marca) inicio++;
  for (const v of _macdStore.variantes) {
    if (v.cfg.tf !== tf) continue;
    // Si entre lo último visto de la operación y la vela más antigua disponible falta un
    // trozo, lo que le pasó en ese hueco no se puede saber.
    for (const t of v.abiertas.filter(x => x.s === sym && d.t[0] > Math.max(marca, x.ts) + ms)) {
      if (!t.pend) v.tot.anuladas++;
      v.abiertas.splice(v.abiertas.indexOf(t), 1);
    }
    _paperCorrer(v, sym, d, inicio);
  }
}

// Una variante nueva no espera: arranca con las velas que ya están en memoria.
function _paperSembrar(v) {
  for (const [key, d] of _macdData) {
    const [sym, tf] = key.split('|');
    if (tf === v.cfg.tf && d.m) _paperCorrer(v, sym, d, d.desde);
  }
}

function paperMonedasAbiertas() {
  const out = [];
  for (const v of _macdStore.variantes) for (const t of v.abiertas) out.push([v.cfg.tf, t.s]);
  return out;
}

// Una moneda retirada de Bybit deja de dar velas y su operación no llegaría al plazo.
function paperLimpiar(now) {
  for (const v of _macdStore.variantes) {
    for (const t of v.abiertas.filter(x => now - x.ts > PAPER_PLAZO_MS + 864e5)) {
      if (!t.pend) v.tot.anuladas++;
      v.abiertas.splice(v.abiertas.indexOf(t), 1);
      _macdSucio = true;
    }
  }
}

// ── Lectura ─────────────────────────────────────────────────────────────────
const _paperEsc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const _paperMonto = v => `${v >= 0 ? '+' : '−'}$${Math.abs(v * PAPER_MARGEN / 100).toFixed(2)}`;
const _paperPct = (v, dec = 2) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(dec)}%`;
const _paperCol = v => (v > 0 ? '#2fe08a' : v < 0 ? '#ff6680' : '#d7dde8');

function _paperReglas(c) {
  const partes = [
    `${c.tf} a ${c.lev}x`,
    c.tp ? `objetivo ${c.tp}%` : 'sin objetivo',
    c.sl ? `stop ${c.sl}%` : 'sin stop',
  ];
  if (c.cruce) partes.push('sale en cruce contrario');
  if (c.dir !== 'ambas') partes.push(`solo ${c.dir === 'L' ? 'long' : 'short'}`);
  if (c.entrada === 'limite') partes.push('entrada límite');
  if (c.fast !== MACD_FAST || c.slow !== MACD_SLOW || c.signal !== MACD_SIGNAL) partes.push(`MACD ${c.fast}·${c.slow}·${c.signal}`);
  if (c.taker !== PAPER_BASE.taker || c.maker !== PAPER_BASE.maker) partes.push(`comisión ${c.taker}/${c.maker}`);
  if (c.azar) partes.push('dirección al azar');
  return partes.join(' · ');
}

function _paperNombreAuto(c) {
  const salida = c.sl ? `stop ${c.sl}%` : c.cruce ? 'o cruce' : 'sin stop';
  const extras = [c.lev !== 10 ? `${c.lev}x` : '', c.entrada === 'limite' ? 'límite' : '', c.dir !== 'ambas' ? `solo ${c.dir}` : '', c.azar ? 'azar' : ''].filter(Boolean);
  return `${c.tf} · ${c.tp ? c.tp + '%' : 'sin objetivo'} ${salida}${extras.length ? ' · ' + extras.join(' · ') : ''}`;
}

// El acierto que haría falta para no perder con lo que gana y pierde de media.
function _paperHaceFalta(a) {
  const malas = a.n - a.g;
  if (!a.g || !malas) return null;
  const gana = a.ganado / a.g, pierde = -a.perdido / malas;
  return pierde / (gana + pierde) * 100;
}

function _paperCurva(v) {
  const puntos = [0];
  let acu = 0, pico = 0, caida = 0;
  for (const k of Object.keys(v.serie).map(Number).sort((x, y) => x - y)) {
    acu += v.serie[k];
    puntos.push(acu);
    pico = Math.max(pico, acu);
    caida = Math.max(caida, pico - acu);
  }
  return { puntos, caida };
}

function _paperSparkline(puntos) {
  if (puntos.length < 3) return '<span style="color:#d7dde8">—</span>';
  const W = 92, H = 24, min = Math.min(...puntos), max = Math.max(...puntos), r = (max - min) || 1;
  const x = i => (i / (puntos.length - 1) * W).toFixed(1), y = p => (H - 2 - (p - min) / r * (H - 4)).toFixed(1);
  const col = _paperCol(puntos[puntos.length - 1]);
  return `<svg class="mp-curva" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="#3a4a64" stroke-width="1" stroke-dasharray="2 2"/>
    <polyline fill="none" stroke="${col}" stroke-width="1.4" points="${puntos.map((p, i) => `${x(i)},${y(p)}`).join(' ')}"/></svg>`;
}

function _paperPrecios() {
  return typeof allRows !== 'undefined' ? new Map(allRows.map(r => [r.symbol, r.price])) : new Map();
}
function _paperPrecioDe(t, tf, precios) {
  if (precios.has(t.s)) return precios.get(t.s);
  const d = _macdData.get(t.s + '|' + tf);
  return d && d.n ? d.c[d.n - 1] : null;
}
// Lo que lleva sobre margen, sin descontar aún la comisión de salida.
function _paperFlotante(t, c, px) {
  return px > 0 ? Math.max(-100, t.d * (px / t.e - 1) * 100 * c.lev) : null;
}

// Neto medio con su margen de error al 95%: sin él, la media de pocas operaciones
// parece una conclusión. Verde o rojo solo si el margen de error no toca el 0.
function _paperCeldaNeto(a) {
  if (!a.n) return '<td style="color:#d7dde8">—</td>';
  const m = a.neto / a.n;
  const e = a.n > 1 ? 1.96 * Math.sqrt(Math.max(0, a.neto2 / a.n - m * m)) / Math.sqrt(a.n) : null;
  const col = e != null && m - e > 0 ? '#2fe08a' : e != null && m + e < 0 ? '#ff6680' : '#eef2fa';
  return `<td style="color:${col}" title="Neto medio por operación sobre margen, con su margen de error al 95%. En verde o rojo solo si el margen de error no toca el 0; en blanco, todavía no se puede concluir.">${_paperPct(m)}${e != null ? ` <span style="opacity:.75">±${e.toFixed(2)}</span>` : ''}</td>`;
}

function _paperFila(v, seleccionada, precios) {
  const a = v.tot, c = v.cfg, { puntos, caida } = _paperCurva(v);
  const vivas = v.abiertas.filter(t => !t.pend);
  const flotantes = vivas.map(t => _paperFlotante(t, c, _paperPrecioDe(t, c.tf, precios))).filter(x => x != null);
  const flotante = flotantes.reduce((s, x) => s + x, 0);
  const falta = _paperHaceFalta(a);
  return `<tr class="mp-fila${seleccionada ? ' mp-sel' : ''}" onclick="paperSeleccionar('${v.id}')">
    <td><b>${_paperEsc(v.nombre)}</b><div class="mp-reglas">${_paperEsc(_paperReglas(c))}</div></td>
    <td>${a.n}</td>
    <td>${a.n ? Math.round(a.g / a.n * 100) + '%' : '—'}</td>
    <td title="El acierto que haría falta para no perder, con lo que gana y pierde de media">${falta == null ? '—' : Math.round(falta) + '%'}</td>
    ${_paperCeldaNeto(a)}
    <td style="color:${_paperCol(a.neto)};font-weight:700">${a.n ? _paperMonto(a.neto) : '—'}</td>
    <td style="color:${caida > 0 ? '#ff9a9a' : '#d7dde8'}" title="La mayor caída desde un máximo de la curva, en la resolución de la curva">${caida > 0 ? '−$' + (caida * PAPER_MARGEN / 100).toFixed(2) : '—'}</td>
    <td>${vivas.length}</td>
    <td style="color:${_paperCol(flotante)}" title="Lo que llevan las abiertas ahora mismo, sin contar en Acumulado. En las variantes sin stop, aquí se ven las que van perdiendo.">${flotantes.length ? _paperMonto(flotante) : '—'}</td>
    <td>${_paperSparkline(puntos)}</td>
    <td class="mp-acc">
      <button onclick="event.stopPropagation();paperAbrirForm('${v.id}')" title="Crear otra variante a partir de esta">✏️</button>
      <button onclick="event.stopPropagation();paperReiniciar('${v.id}')" title="Empezar esta variante de cero">↺</button>
      <button onclick="event.stopPropagation();paperBorrar('${v.id}')" title="Borrar esta variante">✕</button>
    </td>
  </tr>`;
}

function _paperDetalle(v, precios) {
  const a = v.tot, c = v.cfg;
  const lado = (nombre, col, x) => (x[0]
    ? `<span><b style="color:${col}">${nombre}</b> ${x[0]} ops · acierta ${Math.round(x[1] / x[0] * 100)}% · ${_paperPct(x[2] / x[0])} por op.</span>`
    : `<span><b style="color:${col}">${nombre}</b> sin operaciones</span>`);
  const motivos = Object.keys(PAPER_MOTIVO).filter(k => a.mot[k]).map(k => `${PAPER_MOTIVO[k]} ${a.mot[k]}`).join(' · ') || 'sin salidas todavía';
  const extras = [
    a.saltadas ? `${a.saltadas} señales saltadas por tener ya posición en esa moneda` : '',
    a.sinLlenar ? `${a.sinLlenar} límites sin llenar` : '',
    a.anuladas ? `${a.anuladas} anuladas por falta de velas` : '',
  ].filter(Boolean).join(' · ');

  const abiertas = v.abiertas.slice().sort((x, y) => y.ts - x.ts).slice(0, 15);
  const filasAb = abiertas.map(t => {
    const dirCol = t.d > 0 ? '#2fe08a' : '#ff6680';
    if (t.pend) {
      return `<tr><td class="pt-sym">${t.s}</td><td style="color:${dirCol}">${t.k}</td><td>${fmtPrice(t.e)}</td><td colspan="3">límite esperando</td></tr>`;
    }
    const px = _paperPrecioDe(t, c.tf, precios);
    const fl = _paperFlotante(t, c, px);
    return `<tr><td class="pt-sym">${t.s}</td><td style="color:${dirCol}">${t.k}</td><td>${fmtPrice(t.e)}</td>
      <td>${px ? fmtPrice(px) : '—'}</td>
      <td style="color:${_paperCol(fl || 0)};font-weight:700">${fl == null ? '—' : _paperPct(fl, 1)}</td>
      <td>${fmtDur(Date.now() - t.ts)}</td></tr>`;
  }).join('') || '<tr><td colspan="6" class="pt-empty">Sin operaciones abiertas</td></tr>';
  const terminadas = v.cerradas.slice().sort((x, y) => y.xt - x.xt).slice(0, 15);
  const filasFin = terminadas.map(t => `<tr><td class="pt-sym">${t.s}</td>
      <td style="color:${t.k === 'L' ? '#2fe08a' : '#ff6680'}">${t.k}</td><td>${fmtPrice(t.e)}</td><td>${PAPER_MOTIVO[t.mo] || ''}</td>
      <td style="color:${_paperCol(t.n)};font-weight:700">${_paperPct(t.n, 1)}</td><td>${fmtDur(t.xt - t.ts)}</td></tr>`).join('')
    || '<tr><td colspan="6" class="pt-empty">Sin operaciones terminadas todavía</td></tr>';

  return `<div class="mp-resumen">
      <span><b>${_paperEsc(v.nombre)}</b> · desde ${new Date(v.desde).toISOString().slice(0, 16).replace('T', ' ')} UTC</span>
      ${lado('Long', '#2fe08a', a.L)}${lado('Short', '#ff6680', a.S)}
      <span>Salidas: ${motivos}</span>
      ${a.n ? `<span>Dura ${fmtDur(a.min / a.n * 60_000)} de media · a favor ${_paperPct(a.mfe / a.n, 1)} · en contra ${_paperPct(a.mae / a.n, 1)}</span>` : ''}
      ${extras ? `<span>${extras}</span>` : ''}
    </div>
    <div class="macd-tablas">
      <div><table class="pt-table">
        <thead><tr><th>Abiertas (${v.abiertas.length})</th><th></th><th>Entrada</th><th>Actual</th><th>Sobre margen</th><th>Tiempo</th></tr></thead>
        <tbody>${filasAb}</tbody>
      </table></div>
      <div><table class="pt-table">
        <thead><tr><th>Terminadas (últimas)</th><th></th><th>Entrada</th><th>Salida</th><th>Neto</th><th>Duración</th></tr></thead>
        <tbody>${filasFin}</tbody>
      </table></div>
    </div>`;
}

function renderMacdPanel() {
  const el = document.getElementById('mp-cuerpo');
  if (!el) return;
  const vs = _macdStore.variantes;
  if (!vs.length) {
    el.innerHTML = '<div class="pt-empty">No hay variantes. Pulsa ＋ Nueva variante para crear una.</div>';
    return;
  }
  const precios = _paperPrecios();
  const sel = vs.find(v => v.id === _macdStore.sel) || vs[0];
  el.innerHTML = `
    <div class="mp-nota">Cada operación usa <b>$${PAPER_MARGEN} de margen</b> (+$5 = +5%), con comisión descontada y sin funding. Para ajustar, pulsa <b>✏️</b>: cambias lo que quieras y se crea otra variante, con la original corriendo al lado. Arrancan con las últimas 80 velas (6,7h en 5m, 20h en 15m) y siguen en vivo. Si cierras el screener, al volver recupera hasta <b>3 días en 5m y 9 en 15m</b>. Haz clic en una fila para ver sus operaciones.</div>
    <table class="pt-table mp-tabla">
      <thead><tr><th>Variante</th><th>Ops</th><th>Acierto</th><th>Hace falta</th><th>Neto por op.</th><th>Acumulado</th><th>Caída máx.</th><th>Abiertas</th><th>Flotante</th><th>Curva</th><th></th></tr></thead>
      <tbody>${vs.map(v => _paperFila(v, v === sel, precios)).join('')}</tbody>
    </table>
    ${_paperDetalle(sel, precios)}`;
}

// ── Acciones ────────────────────────────────────────────────────────────────
function _paperGuardarYPintar() {
  _macdSucio = true;
  _macdGuardar();
  renderMacdPanel();
}

function paperSeleccionar(id) {
  _macdStore.sel = id;
  _paperGuardarYPintar();
}

function paperReiniciar(id) {
  const v = _macdStore.variantes.find(x => x.id === id);
  if (!v || !confirm(`¿Empezar de cero "${v.nombre}"? Se borran sus resultados.`)) return;
  Object.assign(v, { desde: Date.now(), abiertas: [], cerradas: [], tot: _paperTotVacio(), serie: {}, ancho: 1 });
  _paperSembrar(v);
  _paperGuardarYPintar();
}

function paperBorrar(id) {
  const v = _macdStore.variantes.find(x => x.id === id);
  if (!v || !confirm(`¿Borrar "${v.nombre}" y sus resultados?`)) return;
  _macdStore.variantes.splice(_macdStore.variantes.indexOf(v), 1);
  _paperGuardarYPintar();
}

// El panel se repinta en cada ciclo de datos; el formulario va en su propio contenedor
// para que no se borre mientras se escribe.
function paperAbrirForm(id) {
  const el = document.getElementById('mp-form');
  if (!el) return;
  const origen = id ? _macdStore.variantes.find(x => x.id === id) : null;
  const c = origen ? origen.cfg : PAPER_FORM;
  const opcion = (valor, actual, texto) => `<option value="${valor}"${valor === actual ? ' selected' : ''}>${texto}</option>`;
  const numero = (campo, valor, texto, extra = '') => `<label>${texto}<input id="mp-f-${campo}" type="number" value="${valor}" oninput="paperActualizarAyuda()" ${extra}></label>`;
  el.hidden = false;
  el.innerHTML = `
    <div class="mp-form-titulo">Nueva variante${origen ? ` a partir de "${_paperEsc(origen.nombre)}"` : ''} <span>· la original sigue corriendo para comparar</span></div>
    <div class="mp-campos">
      <label class="mp-ancho">Nombre (opcional)<input id="mp-f-nombre" type="text" maxlength="40" placeholder="Se pone solo según las reglas"></label>
      <label>Temporalidad<select id="mp-f-tf" onchange="paperActualizarAyuda()">${opcion('5m', c.tf, '5m')}${opcion('15m', c.tf, '15m')}</select></label>
      <label>Dirección<select id="mp-f-dir" onchange="paperActualizarAyuda()">${opcion('ambas', c.dir, 'Long y short')}${opcion('L', c.dir, 'Solo long (L)')}${opcion('S', c.dir, 'Solo short (S)')}</select></label>
      ${numero('lev', c.lev, 'Apalancamiento (x)', 'min="1" max="100" step="1"')}
      ${numero('tp', c.tp, 'Objetivo (% margen, 0 = sin)', 'min="0" step="0.5"')}
      ${numero('sl', c.sl, 'Stop (% margen, 0 = sin)', 'min="0" step="0.5"')}
      <label class="mp-check"><input id="mp-f-cruce" type="checkbox"${c.cruce ? ' checked' : ''} onchange="paperActualizarAyuda()">Salir en cruce contrario</label>
      <label class="mp-ancho">Entrada<select id="mp-f-entrada" onchange="paperActualizarAyuda()">${opcion('mercado', c.entrada, 'A mercado, al abrir la vela siguiente')}${opcion('limite', c.entrada, 'Límite en el cierre de la señal (vale 1 vela)')}</select></label>
      ${numero('taker', c.taker, 'Comisión taker (%)', 'min="0" step="0.005"')}
      ${numero('maker', c.maker, 'Comisión maker (%)', 'min="0" step="0.005"')}
      ${numero('fast', c.fast, 'MACD rápida', 'min="2" max="60" step="1"')}
      ${numero('slow', c.slow, 'MACD lenta', 'min="3" max="60" step="1"')}
      ${numero('signal', c.signal, 'MACD señal', 'min="2" max="60" step="1"')}
      <label class="mp-check"><input id="mp-f-azar" type="checkbox"${c.azar ? ' checked' : ''}>Control: dirección al azar</label>
    </div>
    <div id="mp-ayuda"></div>
    <div class="mp-botones">
      <button class="pt-btn mp-nueva" style="margin-left:0" onclick="paperCrear()">Crear y probar</button>
      <button class="pt-btn" onclick="paperCerrarForm()">Cancelar</button>
    </div>`;
  paperActualizarAyuda();
}

function paperCerrarForm() {
  const el = document.getElementById('mp-form');
  if (el) { el.hidden = true; el.innerHTML = ''; }
}

function _paperLeerForm() {
  const val = campo => document.getElementById('mp-f-' + campo);
  const num = campo => Number(val(campo).value);
  const cfg = {
    tf: val('tf').value, dir: val('dir').value, lev: num('lev'), tp: num('tp'), sl: num('sl'),
    cruce: !!val('cruce').checked, entrada: val('entrada').value, taker: num('taker'), maker: num('maker'),
    fast: num('fast'), slow: num('slow'), signal: num('signal'), azar: !!val('azar').checked,
  };
  const enteros = [cfg.lev, cfg.fast, cfg.slow, cfg.signal];
  if (![cfg.tp, cfg.sl, cfg.taker, cfg.maker, ...enteros].every(Number.isFinite)) return { error: 'Hay un campo sin número.' };
  if (!MACD_TF[cfg.tf]) return { error: 'Temporalidad no válida.' };
  if (cfg.lev < 1 || cfg.lev > 100 || !Number.isInteger(cfg.lev)) return { error: 'El apalancamiento va de 1 a 100, sin decimales.' };
  if (cfg.tp < 0 || cfg.sl < 0 || cfg.taker < 0 || cfg.maker < 0) return { error: 'Objetivo, stop y comisiones no pueden ser negativos.' };
  if (cfg.taker > 1 || cfg.maker > 1) return { error: 'La comisión va en % por lado: en Bybit, 0,055 taker y 0,02 maker.' };
  if (!cfg.tp && !cfg.sl && !cfg.cruce) return { error: 'Hace falta alguna salida: objetivo, stop o cruce contrario.' };
  if (![cfg.fast, cfg.slow, cfg.signal].every(x => Number.isInteger(x) && x >= 2 && x <= 60)) return { error: 'Los periodos del MACD van de 2 a 60, sin decimales: con más, las 200 velas no dan para calcularlo bien.' };
  if (cfg.fast >= cfg.slow) return { error: 'La media rápida tiene que ser menor que la lenta.' };
  return { cfg, nombre: (val('nombre')?.value || '').trim() };
}

function paperActualizarAyuda() {
  const el = document.getElementById('mp-ayuda');
  if (!el) return;
  const r = _paperLeerForm();
  if (r.error) { el.innerHTML = `<b style="color:#ff6680">${_paperEsc(r.error)}</b>`; return; }
  const c = r.cfg, liq = 100 / c.lev - PAPER_MMR, f = v => v.toFixed(2).replace('.', ',');
  const comObjetivo = _paperComision(c, true) * c.lev, comOtra = _paperComision(c, false) * c.lev;
  const partes = [
    c.tp ? `objetivo a ${f(c.tp / c.lev)}% de precio` : 'sin objetivo',
    !c.sl ? `sin stop: se liquida a −${f(liq)}% de precio`
      : c.sl / c.lev >= liq ? `el stop queda más lejos que la liquidación (−${f(liq)}% de precio): se liquidaría antes`
        : `stop a ${f(c.sl / c.lev)}% de precio`,
    `comisión de ida y vuelta: ${f(comObjetivo)}% del margen si cobra y ${f(comOtra)}% si no`,
  ];
  if (c.tp && c.sl && !c.cruce && c.sl / c.lev < liq) {
    const gana = c.tp - comObjetivo, pierde = c.sl + comOtra;
    partes.push(gana > 0 ? `para no perder hace falta acertar el ${Math.round(pierde / (gana + pierde) * 100)}%` : 'el objetivo no cubre ni la comisión');
  }
  el.textContent = `A ${c.lev}x: ${partes.join(' · ')}.`;
}

function paperCrear() {
  const r = _paperLeerForm(), ayuda = document.getElementById('mp-ayuda');
  if (r.error) { ayuda.innerHTML = `<b style="color:#ff6680">${_paperEsc(r.error)}</b>`; return; }
  if (_macdStore.variantes.length >= PAPER_MAX_VARIANTES) {
    ayuda.innerHTML = `<b style="color:#ff6680">Máximo ${PAPER_MAX_VARIANTES} variantes: borra alguna antes de crear otra.</b>`;
    return;
  }
  const v = _paperNueva(r.nombre || _paperNombreAuto(r.cfg), r.cfg);
  _macdStore.variantes.push(v);
  _paperSembrar(v);
  _macdStore.sel = v.id;
  paperCerrarForm();
  _paperGuardarYPintar();
}

function paperExportar() {
  const datos = {
    exportadoEl: new Date().toISOString(),
    origen: location.origin,
    margenPorOperacion: PAPER_MARGEN,
    unidades: 'neto en % de margen; serie: neto por tramo de "ancho" horas',
    variantes: _macdStore.variantes,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(datos, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `macd-paper-${location.hostname}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
