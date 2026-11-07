/* public/spotwm.js
 * 🪙 SEGUIMIENTO EN SPOT de las rupturas W/M en 4h: ¿se gana dinero comprando de verdad,
 * sin apalancamiento?
 *
 * En spot no hay cortos, así que cada patrón hace lo único que se puede hacer con él:
 *   · W: compra. Cada variante es una forma distinta de salir.
 *   · M: vende lo que ya tienes. Dos variantes venden su compra al romperse una M en esa moneda;
 *     otra, aparte, mide cuánto se ahorra quien ya la tenía y vuelve a comprarla más abajo. Eso
 *     no es ganancia partiendo de cero: por eso no se suma con las compras.
 *
 * Cómo se simula cada vela de 4h cerrada:
 *   · El detector es el del screener (_detectDouble con PATTERN_CFG_4H) y ve lo mismo que él:
 *     unas 50 velas de 4h y la vela en curso. Pero con velas de spot, no de futuros.
 *   · Solo cuenta la vela que acaba de cerrar más allá del cuello. Se entra a mercado en la
 *     apertura de la vela siguiente, que es lo más pronto que se podría hacer.
 *   · Si en una vela caben stop y objetivo se supone el stop. Si abre más allá del stop, se
 *     sale a esa apertura.
 *   · Una compra por moneda y variante. El dinero en spot queda atado, así que se mide también
 *     cuánto capital hizo falta a la vez.
 *   · Sin funding y sin liquidación. Comisión de Bybit spot: 0,1% por lado, más 0,05% de
 *     deslizamiento a mercado (medido: la mitad del spread es 0,02% de mediana y 0,07% en las
 *     más finas).
 *
 * Corre en el navegador, con sus propias peticiones a Bybit y sin pasar por Render. Todo sale de
 * velas cerradas, así que al volver a abrir el screener se procesan las que faltan, con el
 * mismo resultado que si hubiera estado abierto (Bybit da hasta 1000 velas, 166 días).
 *
 * Lo que dio en 109 monedas desde 2022, con este mismo código (noviembre de 2026): las compras con
 * objetivo o trailing pierden entre 0,29% y 0,51% por operación, casi igual que comprar al azar. Las
 * dos que venden en M ganan en media (+0,57% y +0,99%), pero el margen de error toca el 0, siguen
 * al mercado (2022 y 2025 en negativo) y el azar con esa misma salida da +0,28% y +0,81%. Las
 * monedas son las de más volumen hoy, así que todo esto sale favorecido. BTC mantenido: +74%.
 */

const SPOT_MS       = PATTERN_CFG_4H.ms;
const SPOT_VENTANA  = 50;     // velas cerradas que ve el detector: las ~50 de 4h del screener
const SPOT_MIN_VELAS = 30;    // antes de esto el detector no tiene con qué trabajar
const SPOT_MONTO    = 100;    // $ por compra: +$5 = +5%
const SPOT_COM      = 0.1;    // % por lado, maker y taker
const SPOT_SLIP     = 0.05;   // % por lado a mercado
const SPOT_ATR_STOP = 0.3;    // el stop queda a 0,3 ATR del nivel, igual que en el screener
const SPOT_TRAIL_ARMA = 5;    // % de ganancia al que se arma el trailing, la regla del usuario
const SPOT_TRAIL_ATR  = 1.5;
const SPOT_CERRADAS = 60;     // compras terminadas que se conservan por variante
const SPOT_CERRADAS_HIST = 20; // en lo reconstruido: no cambia y solo se listan las últimas
const SPOT_SERIE_MAX = 200;   // puntos de la curva: al pasarse, cada punto vale el doble de días

// Hash repetible: dos pestañas y una recarga eligen lo mismo.
function _spotAzar(sym, ts, semilla = 0) {
  let h = (2166136261 ^ Math.imul(semilla, 0x9e3779b1)) | 0;
  for (const ch of sym + ':' + ts) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15; h = Math.imul(h, 0x2e1b2137); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const _spotR = v => Math.round(v * 1e4) / 1e4;
const _spotTotVacio = () => ({
  n: 0, g: 0, neto: 0, ganado: 0, perdido: 0, mae: 0, mfe: 0, min: 0,
  mot: { T: 0, P: 0, R: 0, M: 0, H: 0, F: 0 }, saltadas: 0, filtradas: 0, anuladas: 0, ambas: 0, capMax: 0,
});

// Las reglas no se guardan con los resultados: viven en SPOT_VARIANTES.
const spotNuevaVariante = () => ({ abiertas: [], cerradas: [], tot: _spotTotVacio(), serie: {}, ancho: 1 });
// Un control solo guarda sus totales: son varios por variante y no se listan.
const _spotNuevoControl = () => ({ ...spotNuevaVariante(), ligero: true });

// ── Detector ────────────────────────────────────────────────────────────────
// Lo que se ve al cerrar la vela i. La vela en curso es solo su apertura: es lo que se sabe en
// ese momento, y así el resultado no depende de cuándo se procese.
function _spotVentana(d, i) {
  const a = Math.max(0, i - SPOT_VENTANA + 1), b = i + 2;
  const k = { t: d.t.slice(a, b), o: d.o.slice(a, b), h: d.h.slice(a, b), l: d.l.slice(a, b), c: d.c.slice(a, b), v: d.v.slice(a, b) };
  const u = k.c.length - 1;
  k.h[u] = k.l[u] = k.c[u] = k.o[u];
  k.v[u] = 0;
  return k;
}

// Ruptura confirmada al cierre de la vela i, o null.
function spotDetectar(d, i) {
  if (i + 1 >= d.n) return null;
  const k = _spotVentana(d, i);
  const p = _detectDouble(k, PATTERN_CFG_4H);
  if (!p || p.state !== 'breaking' || p.barsSinceBreak !== 0) return null;
  p.t2 = k.t[p.p2.i];
  p.tn = k.t[p.neckIdx];
  return p;
}

// ATR de la misma ventana, para el control.
const spotAtr = (d, i) => _patAtr(_spotVentana(d, i));

// ── Motor ───────────────────────────────────────────────────────────────────
// % de ida y vuelta. Se entra a mercado; el objetivo es una orden límite y no desliza.
const _spotComision = esObjetivo => SPOT_COM + SPOT_SLIP + SPOT_COM + (esObjetivo ? 0 : SPOT_SLIP);

// Neto en % de lo comprado. d = 1 compra; d = −1 vende lo que tiene y recompra después.
function _spotNeto(t, px, motivo) {
  return Math.max(-100, t.d * (px / t.e - 1) * 100 - _spotComision(motivo === 'T'));
}

// Neto y operaciones por día de cierre: da la curva y el margen de error, porque las compras
// de un mismo día se mueven juntas y no valen como datos independientes.
function _spotSerie(v, ts, neto) {
  const k = Math.floor(ts / (864e5 * v.ancho));
  const p = v.serie[k] || (v.serie[k] = [0, 0]);
  p[0] = _spotR(p[0] + neto);
  p[1]++;
  if (Object.keys(v.serie).length <= SPOT_SERIE_MAX) return;
  const nueva = {};
  for (const [a, x] of Object.entries(v.serie)) {
    const b = Math.floor(a / 2), q = nueva[b] || (nueva[b] = [0, 0]);
    q[0] = _spotR(q[0] + x[0]);
    q[1] += x[1];
  }
  v.serie = nueva;
  v.ancho *= 2;
}

function _spotCerrar(v, t, ts, px, motivo) {
  const a = v.tot, neto = _spotNeto(t, px, motivo);
  a.n++;
  if (neto > 0) { a.g++; a.ganado = _spotR(a.ganado + neto); } else a.perdido = _spotR(a.perdido + neto);
  a.neto = _spotR(a.neto + neto);
  a.mae = _spotR(a.mae + t.mn);
  a.mfe = _spotR(a.mfe + t.mx);
  a.min = Math.round(a.min + (ts - t.ts) / 60_000);
  a.mot[motivo]++;
  if (t.amb) a.ambas++;
  v.abiertas.splice(v.abiertas.indexOf(t), 1);
  if (v.ligero) return;
  v.cerradas.push({ s: t.s, d: t.d, ts: t.ts, e: t.e, st0: t.st0, ob: t.ob, cu: t.cu, su: t.su, t1: t.t1, t2: t.t2, xt: ts, x: px, mo: motivo, n: _spotR(neto) });
  const tope = v.tope || SPOT_CERRADAS;
  if (v.cerradas.length > tope) v.cerradas.splice(0, v.cerradas.length - tope);
  _spotSerie(v, ts, neto);
}

// Qué le pasa a la operación en la vela i: { px, mo } si sale, o null.
function _spotSalida(c, t, d, i) {
  const fav = t.d > 0 ? (d.h[i] / t.e - 1) * 100 : (1 - d.l[i] / t.e) * 100;
  const con = t.d > 0 ? (d.l[i] / t.e - 1) * 100 : (1 - d.h[i] / t.e) * 100;
  t.mx = _spotR(Math.max(t.mx, fav));
  t.mn = _spotR(Math.min(t.mn, con));

  const tocaStop = t.st != null && (t.d > 0 ? d.l[i] <= t.st : d.h[i] >= t.st);
  const tocaObj  = t.ob != null && (t.d > 0 ? d.h[i] >= t.ob : d.l[i] <= t.ob);
  if (tocaStop) {
    if (tocaObj) t.amb = 1;   // dice cuánto pesa suponer lo peor
    return { px: t.d > 0 ? Math.min(t.st, d.o[i]) : Math.max(t.st, d.o[i]), mo: t.armado ? 'R' : 'P' };
  }
  if (tocaObj) return { px: t.ob, mo: 'T' };

  // El trailing se mueve con el cierre: moverlo por una mecha que se deshace daría una
  // ventaja que no existe. Rige desde la vela siguiente.
  if (c.trail) {
    if (!t.armado && t.d * (d.c[i] / t.e - 1) * 100 >= SPOT_TRAIL_ARMA) t.armado = true;
    if (t.armado) {
      const cand = d.c[i] - t.d * SPOT_TRAIL_ATR * t.atr;
      t.st = t.st == null ? cand : t.d > 0 ? Math.max(t.st, cand) : Math.min(t.st, cand);
    }
  }
  if (d.t[i] + SPOT_MS - t.ts >= c.plazo * SPOT_MS) return { px: d.c[i], mo: 'H' };
  return null;
}

// Niveles de una operación nueva, o null si ya no hay entrada válida.
function _spotNiveles(c, p, e, atr) {
  const d = c.lado === 'M' ? -1 : 1;
  let st = null, ob = null, cu = null, su = null;
  if (c.lado === 'azar') {
    if (c.stopAtr) st = e - c.stopAtr * atr;
    if (c.objAtr) ob = e + c.objAtr * atr;
  } else {
    cu = p.neckline;
    su = d > 0 ? Math.min(p.p1.price, p.p2.price) : Math.max(p.p1.price, p.p2.price);
    if (c.stop === 'cuello') st = p.neckline - d * SPOT_ATR_STOP * p.atr;
    if (c.stop === 'suelo') st = p.stop;
    if (c.obj) ob = p.target;
  }
  if (st != null && (d > 0 ? st >= e : st <= e)) return null;   // ya está más allá del stop
  if (ob != null && (d > 0 ? ob <= e : ob >= e)) return null;   // ya pasó el objetivo
  return { d, st, ob, cu, su };
}

// Procesa el cierre de la vela i para una variante. pat = ruptura de esa moneda en ese cierre.
function spotProcesar(v, c, sym, d, i, pat, semilla = 0) {
  const cierre = d.t[i] + SPOT_MS;
  let t = v.abiertas.find(x => x.s === sym) || null;

  if (t && d.t[i] >= t.ts) {
    const s = _spotSalida(c, t, d, i);
    if (s) { _spotCerrar(v, t, cierre, s.px, s.mo); t = null; }
  }
  if (t && c.venderEnM && pat && pat.type === 'M' && i + 1 < d.n) {
    _spotCerrar(v, t, cierre, d.o[i + 1], 'M');
    t = null;
  }

  const entra = c.lado === 'azar' ? _spotAzar(sym, d.t[i], semilla) < c.prob : pat && pat.type === c.lado;
  if (!entra || i + 1 >= d.n) return;
  if (t) { v.tot.saltadas++; return; }

  const e = d.o[i + 1];
  const atr = c.lado === 'azar' ? spotAtr(d, i) : pat.atr;
  if (!(e > 0) || !(atr > 0)) return;
  const niv = _spotNiveles(c, pat, e, atr);
  if (!niv) { v.tot.filtradas++; return; }
  if (c.rrMin && Math.abs(niv.ob - e) / Math.abs(e - niv.st) < c.rrMin) { v.tot.filtradas++; return; }
  v.abiertas.push({
    s: sym, d: niv.d, ts: cierre, e, st: niv.st, st0: niv.st, ob: niv.ob, cu: niv.cu, su: niv.su, atr,
    t1: c.lado === 'azar' ? null : pat.startAt, t2: c.lado === 'azar' ? null : pat.t2, mx: 0, mn: 0,
  });
  v.tot.capMax = Math.max(v.tot.capMax, v.abiertas.length);
}

// ── Variantes ───────────────────────────────────────────────────────────────
// Cada compra lleva un control con las mismas salidas: compra al azar en las mismas monedas, a la
// misma frecuencia y con las distancias medianas de una W en 4h, medidas en 682.890 velas de
// spot desde 2022. Si una variante no le gana a su control, el patrón no aporta: el resultado
// viene del mercado y de las monedas. La M vende sobre lo que ya se tiene: no lleva control.
// Son varios intentos porque uno solo varía demasiado (en 166 días, de −0,49% a +0,04%).
const SPOT_AZAR_PROB = 0.0165;   // 1,65% de las velas de una moneda cierran rompiendo una W
const SPOT_AZAR_INTENTOS = 8;
const _spotSemilla = k => (k + 1) * 7919 + 13;
const SPOT_VARIANTES = [
  { id: 'cuello', nombre: 'W · objetivo, stop bajo el cuello', reglas: 'Tu regla de W/M: paga al menos 1:1, 7 días como máximo',
    lado: 'W', obj: true, stop: 'cuello', rrMin: 1, plazo: 42, azar: { stopAtr: 0.55, objAtr: 1.59 } },
  { id: 'suelo', nombre: 'W · objetivo, stop tras el suelo', reglas: 'Stop lejos, bajo los dos suelos, 7 días como máximo',
    lado: 'W', obj: true, stop: 'suelo', plazo: 42, azar: { stopAtr: 2.6, objAtr: 1.41 } },
  { id: 'sinstop', nombre: 'W · objetivo, sin stop', reglas: 'En spot no te liquidan: espera hasta 30 días y vende',
    lado: 'W', obj: true, stop: null, plazo: 180, azar: { objAtr: 1.41 } },
  { id: 'trail', nombre: 'W · trailing desde +5%', reglas: 'Sin objetivo: al ir +5% el stop sigue al precio a 1.5 ATR, 30 días como máximo',
    lado: 'W', obj: false, stop: 'suelo', trail: true, plazo: 180, azar: { stopAtr: 2.6, trail: true } },
  { id: 'wm', nombre: 'Compra en W, vende en M', reglas: 'Vende al romperse una M en esa moneda, con stop tras el suelo, 60 días como máximo',
    lado: 'W', obj: false, stop: 'suelo', venderEnM: true, plazo: 360, azar: { stopAtr: 2.6, venderEnM: true } },
  { id: 'wmsin', nombre: 'Compra en W, vende en M, sin stop', reglas: 'Vende solo al romperse una M, 60 días como máximo',
    lado: 'W', obj: false, stop: null, venderEnM: true, plazo: 360, azar: { venderEnM: true } },
  { id: 'm', nombre: 'M · vender lo que ya tienes', reglas: 'Vende al romperse la M y recompra en su objetivo o en su stop, 7 días como máximo',
    lado: 'M', obj: true, stop: 'suelo', plazo: 42 },
];
const _spotCfgDe = id => SPOT_VARIANTES.find(c => c.id === id);
const _spotCfgAzar = c => ({ lado: 'azar', prob: SPOT_AZAR_PROB, plazo: c.plazo, ...c.azar });

function _spotNuevoJuego() {
  const juego = { variantes: {}, controles: {} };
  for (const c of SPOT_VARIANTES) {
    juego.variantes[c.id] = spotNuevaVariante();
    if (c.azar) juego.controles[c.id] = Array.from({ length: SPOT_AZAR_INTENTOS }, _spotNuevoControl);
  }
  return juego;
}
const _spotTodas = juego => [...Object.values(juego.variantes), ...Object.values(juego.controles).flat()];

// Avanza varias monedas a la vez en orden de tiempo, para que el capital usado y la curva salgan
// como en una cuenta real. marcas[sym] = última vela ya procesada.
async function spotAvanzar(juego, series, marcas, ceder) {
  const items = [];
  for (const [s, d] of series) {
    let i = SPOT_MIN_VELAS;
    if (marcas[s] != null) while (i < d.n && d.t[i] <= marcas[s]) i++;
    items.push({ s, d, i });
  }
  const reglas = SPOT_VARIANTES.map(c => [c, juego.variantes[c.id], juego.controles[c.id], c.azar ? _spotCfgAzar(c) : null]);
  for (let pasos = 0; ; pasos++) {
    let T = Infinity;
    for (const it of items) if (it.i < it.d.n - 1 && it.d.t[it.i] < T) T = it.d.t[it.i];
    if (T === Infinity) break;
    for (const it of items) {
      if (it.i >= it.d.n - 1 || it.d.t[it.i] !== T) continue;
      const pat = spotDetectar(it.d, it.i);
      for (const [c, v, ctls, cAzar] of reglas) {
        spotProcesar(v, c, it.s, it.d, it.i, pat);
        if (ctls) ctls.forEach((ctl, k) => spotProcesar(ctl, cAzar, it.s, it.d, it.i, pat, _spotSemilla(k)));
      }
      marcas[it.s] = T;
      it.i++;
    }
    if (ceder && pasos % 40 === 39) await ceder();
  }
}

// Media por operación y su margen de error al 95%, agrupando por día de cierre.
function spotMedia(v) {
  const a = v.tot;
  if (!a.n) return null;
  const m = a.neto / a.n;
  let q = 0;
  for (const [x, n] of Object.values(v.serie)) q += (x - m * n) ** 2;
  return { m, e: a.n > 1 ? 1.96 * Math.sqrt(q) / a.n : null };
}

// Media de los intentos al azar, con el peor y el mejor: dicen cuánto varía por pura suerte.
function spotMediaAzar(ctls) {
  const ms = (ctls || []).filter(v => v.tot.n).map(v => v.tot.neto / v.tot.n);
  if (!ms.length) return null;
  return { m: ms.reduce((a, b) => a + b, 0) / ms.length, min: Math.min(...ms), max: Math.max(...ms) };
}

// ── Datos ───────────────────────────────────────────────────────────────────
const _SPOT_KEY = 'scalp_spot_wm';
const SPOT_VERSION = 1;
const SPOT_MIN_VOL = 500_000;    // $ al día en spot; por debajo, el libro es demasiado fino
const SPOT_MAX_MONEDAS = 120;
const SPOT_HISTORIA = 1000;      // lo máximo que da Bybit de una vez: 166 días de 4h
const SPOT_WORKERS = 3;
const SPOT_UNIVERSO_MS = 864e5;
const SPOT_PRECIOS_MS = 60_000;  // cada cuánto se actualiza el precio de las abiertas con el panel a la vista
// Monedas estables, envueltas y oro: no son compras de una moneda con su propio movimiento.
const SPOT_EXCLUIR = /^(USDC|USDE|RLUSD|USD1|DAI|FDUSD|TUSD|PYUSD|USDD|USDS|USDT0|USDG|USDTB|EURC|EUR|BUSD|FRAX|GUSD|USDP|LUSD|CRVUSD|GHO|SUSDE|SUSDS|STETH|WSTETH|WBTC|WETH|CBBTC|CBETH|METH|CMETH|TBTC|LBTC|RETH|WEETH|XAUT|XAUM|GOLD|PAXG)USDT$/;

const _spotVacio = () => ({ v: SPOT_VERSION, desde: null, universo: null, marcas: {}, vivo: _spotNuevoJuego(), hist: null, vista: null, sel: SPOT_VARIANTES[0].id, btc0: null });
function _spotCargar() {
  try {
    const s = JSON.parse(localStorage.getItem(_SPOT_KEY));
    if (s && s.v === SPOT_VERSION) return s;
  } catch (_) { /* ilegible: se empieza de cero */ }
  return _spotVacio();
}
let _spotStore = _spotCargar();
function _spotGuardar() {
  if (typeof safeSetItem === 'function') safeSetItem(_SPOT_KEY, JSON.stringify(_spotStore));
}

// Velas de viejo a nuevo. La última puede ser la vela en curso.
function _spotAVelas(lista) {
  const f = (lista || []).slice().reverse();
  const col = k => f.map(x => Number(x[k]));
  return { n: f.length, t: col(0), o: col(1), h: col(2), l: col(3), c: col(4), v: col(5) };
}

async function _spotVelas(sym, limite) {
  const j = await bybitGet(`/v5/market/kline?category=spot&symbol=${encodeURIComponent(sym)}&interval=240&limit=${limite}`);
  return j && j.retCode === 0 && j.result ? _spotAVelas(j.result.list) : null;
}

// De mayor a menor volumen en spot.
function spotFiltrarUniverso(tickers, instrumentos) {
  const info = new Map(instrumentos.map(x => [x.symbol, x]));
  return tickers
    .map(x => ({ s: x.symbol, to: Number(x.turnover24h), i: info.get(x.symbol) }))
    .filter(x => x.i && x.i.quoteCoin === 'USDT' && x.i.status === 'Trading' && x.i.symbolType !== 'xstocks'
      && !SPOT_EXCLUIR.test(x.s) && x.to >= SPOT_MIN_VOL)
    .sort((a, b) => b.to - a.to)
    .slice(0, SPOT_MAX_MONEDAS)
    .map(x => x.s);
}

async function _spotUniverso(now) {
  const u = _spotStore.universo;
  if (u && now - u.t < SPOT_UNIVERSO_MS) return u.monedas;
  try {
    const [tk, ins] = await Promise.all([
      bybitGet('/v5/market/tickers?category=spot'),
      bybitGet('/v5/market/instruments-info?category=spot&limit=1000'),
    ]);
    const monedas = spotFiltrarUniverso(tk.result.list, ins.result.list);
    if (monedas.length) _spotStore.universo = { t: now, monedas };
  } catch (_) { /* sin red: sigue con el que tenía */ }
  return _spotStore.universo ? _spotStore.universo.monedas : [];
}

async function _spotDescargar(lista, limiteDe) {
  const series = new Map();
  let k = 0, hechas = 0;
  await Promise.all(Array.from({ length: SPOT_WORKERS }, async () => {
    while (k < lista.length) {
      const sym = lista[k++];
      if (Date.now() < _bybitBanUntil) return;
      try {
        const d = await _spotVelas(sym, limiteDe(sym));
        if (d && d.n) series.set(sym, d);
      } catch (_) { /* esa moneda se recupera en el siguiente ciclo: su marca no avanza */ }
      _spotProgreso = `${++hechas} de ${lista.length} monedas`;
      if (hechas % 10 === 0) _spotPintarSiVisible();
      await new Promise(r => setTimeout(r, 80));
    }
  }));
  return series;
}

const _spotCeder = () => new Promise(r => setTimeout(r, 0));

// Compara con mantener: BTC y todas las monedas con datos desde el inicio del tramo. El inicio es la
// mediana: una moneda con huecos en sus velas empieza días antes y no debe mover el de las demás. Se
// admite un día de diferencia porque una descarga puede cruzar un cierre de vela.
function spotReferencias(series) {
  const inicios = [...series.values()].map(d => d.t[0]).sort((a, b) => a - b);
  const desde = inicios[inicios.length >> 1];
  let hasta = 0;
  for (const d of series.values()) hasta = Math.max(hasta, d.t[d.n - 1]);
  const rets = [];
  for (const d of series.values()) if (d.t[0] <= desde + 864e5) rets.push((d.c[d.n - 1] / d.o[0] - 1) * 100);
  rets.sort((a, b) => a - b);
  const btc = series.get('BTCUSDT');
  return {
    desde, hasta,
    btc: btc ? (btc.c[btc.n - 1] / btc.o[0] - 1) * 100 : null,
    cesta: rets.length ? { n: rets.length, media: rets.reduce((a, b) => a + b, 0) / rets.length, mediana: rets[rets.length >> 1] } : null,
  };
}

// Lo que sigue abierto al final de lo reconstruido se cierra al último precio. Sin esto se quedarían
// fuera justo las que no terminan, que en las variantes sin stop suelen ser las que van perdiendo.
function spotCerrarAlFinal(juego, series) {
  for (const v of _spotTodas(juego)) {
    for (const t of v.abiertas.slice()) {
      const d = series.get(t.s);
      _spotCerrar(v, t, d.t[d.n - 1] + SPOT_MS, d.c[d.n - 1], 'F');
    }
  }
}

// La primera vez: reconstruye lo que Bybit tiene y deja el seguimiento en vivo listo para seguir.
async function _spotReconstruir(monedas) {
  const series = await _spotDescargar(monedas, () => SPOT_HISTORIA);
  if (series.size < monedas.length * 0.8) return false;   // sin datos suficientes: se reintenta luego
  const juego = _spotNuevoJuego();
  await spotAvanzar(juego, series, {}, _spotCeder);
  spotCerrarAlFinal(juego, series);
  for (const v of Object.values(juego.variantes)) v.cerradas = v.cerradas.slice(-SPOT_CERRADAS_HIST);
  _spotStore.hist = { hecho: Date.now(), monedas: series.size, ...spotReferencias(series), ...juego };
  // El seguimiento en vivo arranca aquí: lo reconstruido no se mezcla con él.
  const marcas = {};
  for (const [s, d] of series) marcas[s] = d.t[Math.max(0, d.n - 2)];
  _spotStore.marcas = marcas;
  _spotStore.desde = Date.now();
  const btc = series.get('BTCUSDT');
  _spotStore.btc0 = btc ? btc.c[btc.n - 1] : null;
  return true;
}

// Una operación que ya pasó su plazo y sigue sin velas: la moneda dejó de cotizar. Sin datos no
// se puede saber qué pasó, así que se anula en lugar de inventar un resultado.
function spotLimpiar(juego, now) {
  for (const c of SPOT_VARIANTES) {
    for (const v of [juego.variantes[c.id], ...(juego.controles[c.id] || [])]) {
      for (const t of v.abiertas.filter(x => now - x.ts > (c.plazo + 12) * SPOT_MS)) {
        v.tot.anuladas++;
        v.abiertas.splice(v.abiertas.indexOf(t), 1);
      }
    }
  }
}

function spotMonedasAbiertas(juego) {
  const s = new Set();
  for (const v of _spotTodas(juego)) for (const t of v.abiertas) s.add(t.s);
  return s;
}

// Avanza lo que falte de cada moneda. Devuelve cuántas se quedaron sin datos.
async function spotPonerAlDia(juego, marcas, series, now) {
  for (const [s, d] of series) {
    // Moneda nueva en el universo: empieza desde su última vela cerrada, sin inventarle pasado.
    if (marcas[s] == null) { marcas[s] = d.t[Math.max(0, d.n - 2)]; continue; }
    // Faltan velas entre lo último visto y lo que da Bybit: esas operaciones no se pueden resolver.
    if (d.t[0] > marcas[s] + SPOT_MS) {
      for (const v of _spotTodas(juego)) {
        for (const t of v.abiertas.filter(x => x.s === s)) { v.tot.anuladas++; v.abiertas.splice(v.abiertas.indexOf(t), 1); }
      }
    }
  }
  await spotAvanzar(juego, series, marcas, _spotCeder);
  spotLimpiar(juego, now);
}

async function _spotEnVivo(monedas, now) {
  const juego = _spotStore.vivo, marcas = _spotStore.marcas;
  const lista = [...new Set([...monedas, ...spotMonedasAbiertas(juego)])];
  const limiteDe = s => (marcas[s] == null ? 60 : Math.min(SPOT_HISTORIA, Math.ceil((now - marcas[s]) / SPOT_MS) + 60));
  const series = await _spotDescargar(lista, limiteDe);
  if (!series.size) return false;
  await spotPonerAlDia(juego, marcas, series, now);
  return true;
}

// ── Ciclo ───────────────────────────────────────────────────────────────────
let _spotOcupado = false, _spotProximo = 0, _spotProgreso = '', _spotError = false;
let _spotPrecios = new Map(), _spotPreciosT = 0;

const _spotSiguienteCierre = now => (Math.floor(now / SPOT_MS) + 1) * SPOT_MS + 30_000;

async function _spotCiclo() {
  if (_spotOcupado) return;
  const now = Date.now();
  if (now < _spotProximo || now < _bybitBanUntil) return;
  _spotOcupado = true;
  _spotError = false;
  _spotPintarSiVisible();
  let ok = false;
  try {
    const monedas = await _spotUniverso(now);
    if (monedas.length) ok = _spotStore.hist ? await _spotEnVivo(monedas, now) : await _spotReconstruir(monedas);
  } catch (e) {
    console.warn('Spot W/M: ciclo incompleto', e);
  }
  _spotOcupado = false;
  _spotProgreso = '';
  if (ok) {
    _spotProximo = _spotSiguienteCierre(Date.now());
    _spotGuardar();
  } else {
    _spotError = true;
    _spotProximo = Date.now() + 5 * 60_000;
  }
  _spotPintarSiVisible();
  if (typeof renderLabResumen === 'function') renderLabResumen();
}

setInterval(_spotCiclo, 30_000);
setTimeout(_spotCiclo, 12_000);    // después de la primera carga del screener

// ── Lectura ─────────────────────────────────────────────────────────────────
const _spotVisible = () => typeof activeTab !== 'undefined' && activeTab === 'lab' && typeof labVista !== 'undefined' && labVista === 'spot';
function _spotPintarSiVisible() { if (_spotVisible()) renderSpotPanel(); }

// Se ve en vivo cuando ya hay resultados en vivo; hasta entonces, lo reconstruido.
function _spotVista() {
  if (_spotStore.vista === 'vivo' || (_spotStore.vista === 'hist' && _spotStore.hist)) return _spotStore.vista;
  const hayVivo = Object.values(_spotStore.vivo.variantes).some(v => v.tot.n > 0);
  return hayVivo || !_spotStore.hist ? 'vivo' : 'hist';
}
const _spotJuegoActivo = () => (_spotVista() === 'hist' ? _spotStore.hist : _spotStore.vivo);

// Desde $100 los centavos ya no dicen nada.
function _spotMonto(v) {
  const x = Math.abs(v * SPOT_MONTO / 100), dec = x >= 100 ? 0 : 2;
  return `${v >= 0 ? '+' : '−'}$${x.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
}
const _spotCapital = n => '$' + (n * SPOT_MONTO).toLocaleString('en-US');
const _spotMoneda = s => String(s).replace(/USDT$/, '');
const _SPOT_MOTIVO = { T: '🎯 objetivo', P: '🛑 stop', R: '📈 trailing', M: '🔻 rompió una M', H: 'plazo', F: 'fin del tramo' };
const _spotFecha = t => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
function _spotDias(ms) {
  const h = ms / 36e5;
  return h < 48 ? `${Math.round(h)}h` : `${(h / 24).toFixed(1)} días`;
}

function _spotCurva(v) {
  const puntos = [0];
  let acu = 0, pico = 0, caida = 0;
  for (const k of Object.keys(v.serie).map(Number).sort((a, b) => a - b)) {
    acu += v.serie[k][0];
    puntos.push(acu);
    pico = Math.max(pico, acu);
    caida = Math.max(caida, pico - acu);
  }
  return { puntos, caida };
}

const _spotFlotante = (t, px) => (px > 0 ? t.d * (px / t.e - 1) * 100 : null);

function _spotFila(c, v, ctls, seleccionada) {
  const a = v.tot, med = spotMedia(v), azar = spotMediaAzar(ctls);
  const { puntos, caida } = _spotCurva(v);
  const malas = a.n - a.g;
  const falta = a.g && malas ? (-a.perdido / malas) / (a.ganado / a.g - a.perdido / malas) * 100 : null;
  const flotantes = v.abiertas.map(t => _spotFlotante(t, _spotPrecios.get(t.s))).filter(x => x != null);
  const flot = flotantes.reduce((s, x) => s + x, 0);
  const colNeto = med && med.e != null && med.m - med.e > 0 ? '#2fe08a' : med && med.e != null && med.m + med.e < 0 ? '#ff6680' : '#eef2fa';
  return `<tr class="mp-fila${seleccionada ? ' mp-sel' : ''}" onclick="spotSeleccionar('${c.id}')">
    <td><b>${_paperEsc(c.nombre)}</b><div class="mp-reglas">${_paperEsc(c.reglas)}</div></td>
    <td>${a.n}</td>
    <td>${a.n ? Math.round(a.g / a.n * 100) + '%' : '—'}</td>
    <td title="El acierto que haría falta para no perder, con lo que gana y pierde de media">${falta == null ? '—' : Math.round(falta) + '%'}</td>
    <td style="color:${colNeto}" title="Neto medio por operación, ya con comisión, con su margen de error al 95% agrupado por día. En verde o rojo solo si el margen de error no toca el 0.">${med ? `${_paperPct(med.m)}${med.e != null ? ` <span style="opacity:.8">±${med.e.toFixed(2)}</span>` : ''}` : '—'}</td>
    <td title="Lo mismo comprando al azar en estas monedas, con las mismas salidas: la media de ${SPOT_AZAR_INTENTOS} intentos y, entre paréntesis, el peor y el mejor. Si la variante no queda por encima, el patrón no está aportando nada.">${azar ? `${_paperPct(azar.m)} <span style="opacity:.8">(${_paperPct(azar.min).replace('%', '')} a ${_paperPct(azar.max).replace('%', '')})</span>` : c.azar ? '—' : 'no aplica'}</td>
    <td style="color:${_paperCol(a.neto)};font-weight:700">${a.n ? _spotMonto(a.neto) : '—'}</td>
    <td style="color:${caida > 0 ? '#ff9a9a' : '#d7dde8'}" title="La mayor caída desde un máximo de la curva">${caida > 0 ? '−$' + (caida * SPOT_MONTO / 100).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'}</td>
    <td title="La mayor cantidad de dinero atado a la vez: en spot, comprar exige tener el dinero">${a.capMax ? _spotCapital(a.capMax) : '—'}</td>
    <td>${v.abiertas.length}${flotantes.length ? ` <span style="color:${_paperCol(flot)}">${_spotMonto(flot)}</span>` : ''}</td>
    <td>${_paperSparkline(puntos)}</td>
  </tr>`;
}

function _spotReferencia(vista) {
  if (vista === 'hist') {
    const h = _spotStore.hist;
    const partes = [];
    if (h.btc != null) partes.push(`BTC en el mismo periodo <b>${_paperPct(h.btc, 1)}</b>`);
    if (h.cesta) partes.push(`comprar y mantener las ${h.cesta.n} monedas con datos desde el inicio: media <b>${_paperPct(h.cesta.media, 1)}</b>, mediana <b>${_paperPct(h.cesta.mediana, 1)}</b>`);
    return partes.join(' · ');
  }
  const px = _spotPrecios.get('BTCUSDT');
  return _spotStore.btc0 && px ? `BTC desde que empezó <b>${_paperPct((px / _spotStore.btc0 - 1) * 100, 1)}</b>` : '';
}

function _spotNota(vista) {
  if (vista === 'hist') {
    const h = _spotStore.hist;
    return `Reconstruido con las últimas ${SPOT_HISTORIA} velas de 4h de <b>${h.monedas} monedas</b>, del ${_spotFecha(h.desde).slice(0, 10)} al ${_spotFecha(h.hasta).slice(0, 10)}. Son las de más volumen <b>hoy</b>, así que el resultado sale favorecido: no cuenta ninguna de las que se hundieron y salieron de la lista. Por eso importa la columna <b>Al azar</b>. Lo que seguía abierto al final se cierra al último precio.`;
  }
  const n = _spotStore.universo ? _spotStore.universo.monedas.length : 0;
  return _spotStore.desde
    ? `En vivo desde <b>${_spotFecha(_spotStore.desde)} UTC</b> con las <b>${n} monedas</b> de más volumen en spot, renovadas cada día. Sin el sesgo de lo reconstruido, pero en 4h las operaciones tardan días en terminar. Si cierras el screener, al volver recupera lo que pasó.`
    : 'Preparando el seguimiento en vivo…';
}

function _spotDetalle(c, v, vista) {
  const a = v.tot, esVenta = c.lado === 'M';
  const motivos = Object.keys(_SPOT_MOTIVO).filter(k => a.mot[k]).map(k => `${_SPOT_MOTIVO[k]} ${a.mot[k]}`).join(' · ') || 'sin salidas todavía';
  const extras = [
    a.saltadas ? `${a.saltadas} rupturas saltadas por tener ya esa moneda` : '',
    a.filtradas ? `${a.filtradas} descartadas por no pagar 1:1 o por quedar sin niveles válidos` : '',
    a.ambas ? `${a.ambas} velas con stop y objetivo a la vez, contadas como stop` : '',
    a.anuladas ? `${a.anuladas} anuladas por falta de velas` : '',
  ].filter(Boolean).join(' · ');

  const fila = (t, abierta) => {
    const clic = `onclick="spotVerGrafico('${_paperEsc(t.s)}',${t.ts})"`;
    const sym = `<td class="pt-sym">${_paperEsc(_spotMoneda(t.s))}</td><td>${fmtPrice(t.e)}</td>`;
    if (abierta) {
      const px = _spotPrecios.get(t.s), fl = _spotFlotante(t, px);
      return `<tr class="sp-op" ${clic}>${sym}<td>${px ? fmtPrice(px) : '—'}</td><td style="color:${_paperCol(fl || 0)};font-weight:700">${fl == null ? '—' : _paperPct(fl, 1)}</td><td>${_spotDias(Date.now() - t.ts)}</td></tr>`;
    }
    return `<tr class="sp-op" ${clic}>${sym}<td>${_SPOT_MOTIVO[t.mo] || ''}</td><td style="color:${_paperCol(t.n)};font-weight:700">${_paperPct(t.n, 1)}</td><td>${_spotDias(t.xt - t.ts)}</td></tr>`;
  };
  const abiertas = v.abiertas.slice().sort((x, y) => y.ts - x.ts).slice(0, 15).map(t => fila(t, true)).join('')
    || `<tr><td colspan="5" class="sp-vacio">${vista === 'hist' ? 'Lo reconstruido no deja operaciones abiertas' : 'Sin operaciones abiertas'}</td></tr>`;
  const terminadas = v.cerradas.slice().sort((x, y) => y.xt - x.xt).slice(0, 15).map(t => fila(t, false)).join('')
    || '<tr><td colspan="5" class="sp-vacio">Sin operaciones terminadas todavía</td></tr>';
  return `<div class="mp-resumen">
      <span><b>${_paperEsc(c.nombre)}</b></span>
      <span>Salidas: ${motivos}</span>
      ${a.n ? `<span>Dura ${_spotDias(a.min / a.n * 60_000)} de media · a favor ${_paperPct(a.mfe / a.n, 1)} · en contra ${_paperPct(a.mae / a.n, 1)}</span>` : ''}
      ${extras ? `<span>${extras}</span>` : ''}
    </div>
    <div class="macd-tablas">
      <div><table class="pt-table">
        <thead><tr><th>Abiertas (${v.abiertas.length})</th><th>${esVenta ? 'Venta' : 'Compra'}</th><th>Ahora</th><th>Lleva</th><th>Tiempo</th></tr></thead>
        <tbody>${abiertas}</tbody>
      </table></div>
      <div><table class="pt-table">
        <thead><tr><th>Terminadas (últimas)</th><th>${esVenta ? 'Venta' : 'Compra'}</th><th>Salida</th><th>Neto</th><th>Duración</th></tr></thead>
        <tbody>${terminadas}</tbody>
      </table></div>
    </div>`;
}

function renderSpotPanel() {
  const el = document.getElementById('sp-cuerpo');
  if (!el) return;
  _spotActualizarPrecios();
  const estado = document.getElementById('sp-estado');
  if (estado) {
    estado.textContent = _spotOcupado ? `Descargando velas de spot${_spotProgreso ? ': ' + _spotProgreso : '…'}`
      : _spotError ? 'Bybit no respondió del todo: se reintenta en 5 minutos'
      : _spotProximo ? `Próxima revisión: ${_spotFecha(_spotProximo).slice(11)} UTC` : '';
  }
  if (!_spotStore.hist) {
    el.innerHTML = `<div class="sp-vacio">${_spotOcupado ? 'Reconstruyendo los últimos 166 días de spot. La primera vez tarda menos de un minuto…' : 'Esperando la primera descarga de velas de spot…'}</div>`;
    return;
  }
  const vista = _spotVista(), juego = _spotJuegoActivo();
  const nVivo = Object.values(_spotStore.vivo.variantes).reduce((s, v) => s + v.tot.n, 0);
  const sel = _spotCfgDe(_spotStore.sel) || SPOT_VARIANTES[0];
  const filas = lista => lista.map(c => _spotFila(c, juego.variantes[c.id], juego.controles[c.id], c === sel)).join('');
  const ref = _spotReferencia(vista);
  el.innerHTML = `
    <div class="sp-vistas" role="group" aria-label="Qué resultados ver">
      <button class="sp-vista${vista === 'vivo' ? ' activa' : ''}" aria-pressed="${vista === 'vivo'}" onclick="spotCambiarVista('vivo')">En vivo <span>${nVivo} terminadas</span></button>
      <button class="sp-vista${vista === 'hist' ? ' activa' : ''}" aria-pressed="${vista === 'hist'}" onclick="spotCambiarVista('hist')">Últimos 166 días <span>reconstruido</span></button>
    </div>
    <div class="mp-nota">${_spotNota(vista)}</div>
    <div class="mp-nota">Cada compra usa <b>$${SPOT_MONTO}</b>, sin apalancamiento ni funding, con <b>0.1% de comisión por lado</b> y 0.05% de deslizamiento a mercado. En spot no se puede vender en corto, así que la M no abre operaciones: vende lo que tienes. Haz clic en una operación para ver su gráfico.${ref ? `<br>${ref}.` : ''}</div>
    <div class="sp-tabla-caja"><table class="pt-table mp-tabla">
      <thead><tr><th>Variante</th><th>Ops</th><th>Acierto</th><th>Hace falta</th><th>Neto por op.</th><th>Al azar</th><th>Acumulado</th><th>Caída máx.</th><th>Capital a la vez</th><th>Abiertas</th><th>Curva</th></tr></thead>
      <tbody>${filas(SPOT_VARIANTES.filter(c => c.lado !== 'M'))}
        <tr class="sp-sep"><td colspan="11">Si ya tienes la moneda: no es ganancia partiendo de cero y no se suma con las compras</td></tr>
        ${filas(SPOT_VARIANTES.filter(c => c.lado === 'M'))}</tbody>
    </table></div>
    ${_spotDetalle(sel, juego.variantes[sel.id], vista)}`;
}

// Precio de las abiertas: una sola petición con todas las monedas, solo con el panel a la vista.
async function _spotActualizarPrecios() {
  const now = Date.now();
  if (now - _spotPreciosT < SPOT_PRECIOS_MS || now < _bybitBanUntil) return;
  _spotPreciosT = now;
  try {
    const j = await bybitGet('/v5/market/tickers?category=spot');
    const m = new Map();
    for (const x of j.result.list) m.set(x.symbol, Number(x.lastPrice));
    _spotPrecios = m;
    _spotPintarSiVisible();
  } catch (_) { /* se reintenta en el siguiente repintado */ }
}

// Para el botón de la pestaña.
function spotResumen() {
  const vista = _spotVista(), juego = _spotJuegoActivo();
  const c = _spotCfgDe(_spotStore.sel) || SPOT_VARIANTES[0];
  const v = juego.variantes[c.id], med = spotMedia(v);
  if (!med) return { valor: null, sub: _spotOcupado ? 'Descargando velas de spot…' : c.nombre };
  return { valor: med.m, sub: `${vista === 'hist' ? 'reconstruido' : 'en vivo'} · ${c.nombre} · ${v.tot.n} terminadas` };
}

// ── Acciones ────────────────────────────────────────────────────────────────
function spotSeleccionar(id) {
  if (!_spotCfgDe(id)) return;
  _spotStore.sel = id;
  _spotGuardar();
  spotCerrarGrafico();
  renderSpotPanel();
  if (typeof renderLabResumen === 'function') renderLabResumen();
}

function spotCambiarVista(vista) {
  _spotStore.vista = vista;
  _spotGuardar();
  spotCerrarGrafico();
  renderSpotPanel();
  if (typeof renderLabResumen === 'function') renderLabResumen();
}

function spotReiniciar() {
  if (_spotOcupado || !confirm('¿Empezar de cero? Se borran los resultados en vivo y se vuelve a reconstruir lo de los últimos 166 días.')) return;
  _spotStore = _spotVacio();
  _spotProximo = 0;
  _spotGuardar();
  spotCerrarGrafico();
  renderSpotPanel();
  _spotCiclo();
}

function spotExportar() {
  const datos = {
    exportadoEl: new Date().toISOString(),
    origen: location.origin,
    montoPorCompra: SPOT_MONTO,
    costes: { comisionPorLadoPct: SPOT_COM, deslizamientoMercadoPct: SPOT_SLIP },
    variantes: SPOT_VARIANTES,
    unidades: 'neto en % de lo comprado; serie: [neto, operaciones] por tramo de "ancho" días',
    enVivo: _spotStore.vivo, desde: _spotStore.desde, reconstruido: _spotStore.hist, universo: _spotStore.universo,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(datos, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `spot-wm-${location.hostname}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Gráfico de una operación ────────────────────────────────────────────────
// Va en su propio contenedor: el panel se repinta con cada cambio y no debe borrarlo.
let _spotGraficoPedido = 0;

function spotCerrarGrafico() {
  _spotGraficoPedido++;
  const el = document.getElementById('sp-grafico');
  if (el) { el.hidden = true; el.innerHTML = ''; }
}

async function spotVerGrafico(sym, ts) {
  const el = document.getElementById('sp-grafico');
  const v = _spotJuegoActivo().variantes[_spotStore.sel];
  const t = v && (v.cerradas.find(x => x.s === sym && x.ts === ts) || v.abiertas.find(x => x.s === sym && x.ts === ts));
  if (!el || !t) return;
  const pedido = ++_spotGraficoPedido;
  el.hidden = false;
  el.innerHTML = '<div class="sp-vacio">Cargando el gráfico…</div>';
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const ini = (t.t1 ?? t.ts) - 14 * SPOT_MS, fin = Math.min((t.xt ?? Date.now()) + 14 * SPOT_MS, Date.now());
  let d = null;
  try {
    const j = await bybitGet(`/v5/market/kline?category=spot&symbol=${encodeURIComponent(sym)}&interval=240&start=${ini}&end=${fin}&limit=1000`);
    d = _spotAVelas(j.result.list);
  } catch (_) { /* se avisa abajo */ }
  if (pedido !== _spotGraficoPedido) return;   // ya pidió otra operación
  el.innerHTML = d && d.n ? spotDibujarGrafico(t, d) : '<div class="sp-vacio">Bybit no devolvió velas para esta moneda.</div>';
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Velas de spot en 4h con el patrón, los niveles, la entrada y la salida.
function spotDibujarGrafico(t, d) {
  const W = 960, H = 380, M = { i: 8, d: 124, a: 14, b: 26 };
  const venta = t.d < 0;
  const niveles = [
    { p: t.ob, txt: 'Objetivo', col: '#2fe08a', dash: '6 4' },
    { p: t.cu, txt: 'Cuello', col: '#ffbe3c', dash: '' },
    { p: t.su, txt: venta ? 'Techo' : 'Suelo', col: '#7fd4ff', dash: '2 3' },
    { p: t.st0, txt: 'Stop', col: '#ff6680', dash: '6 4' },
  ].filter(n => n.p != null);
  let min = Math.min(...d.l, ...niveles.map(n => n.p)), max = Math.max(...d.h, ...niveles.map(n => n.p));
  const r = (max - min) || max || 1;
  min -= r * 0.04; max += r * 0.04;
  const paso = (W - M.i - M.d) / d.n;
  const X = i => M.i + (i + 0.5) * paso;
  const Y = p => M.a + (max - p) / (max - min) * (H - M.a - M.b);
  const iDe = ts => { let a = 0, b = d.n - 1; while (a < b) { const k = (a + b) >> 1; if (d.t[k] < ts) a = k + 1; else b = k; } return a; };
  const ancho = Math.max(1, paso * 0.62);

  const velas = d.t.map((_, i) => {
    const col = d.c[i] >= d.o[i] ? '#2fe08a' : '#ff6680';
    const a = Y(Math.max(d.o[i], d.c[i])), b = Y(Math.min(d.o[i], d.c[i]));
    return `<line x1="${X(i).toFixed(1)}" x2="${X(i).toFixed(1)}" y1="${Y(d.h[i]).toFixed(1)}" y2="${Y(d.l[i]).toFixed(1)}" stroke="${col}" stroke-width="1"/>`
      + `<rect x="${(X(i) - ancho / 2).toFixed(1)}" y="${a.toFixed(1)}" width="${ancho.toFixed(1)}" height="${Math.max(1, b - a).toFixed(1)}" fill="${col}"/>`;
  }).join('');

  // Las etiquetas de los niveles se separan si caen demasiado juntas.
  let ultimoY = -Infinity;
  const textos = niveles.slice().sort((a, b) => Y(a.p) - Y(b.p)).map(n => {
    const y = Math.max(ultimoY + 15, Y(n.p) + 4);
    ultimoY = y;
    return `<text x="${W - M.d + 6}" y="${y.toFixed(1)}" fill="${n.col}" font-size="12">${n.txt} ${fmtPrice(n.p)}</text>`;
  }).join('');
  const lineas = niveles.map(n => `<line x1="${M.i}" x2="${W - M.d}" y1="${Y(n.p).toFixed(1)}" y2="${Y(n.p).toFixed(1)}" stroke="${n.col}" stroke-width="1.2" stroke-dasharray="${n.dash}"/>`).join('');

  const etiqueta = (i, p, txt, col, arriba) => `<text x="${X(i).toFixed(1)}" y="${(Y(p) + (arriba ? -8 : 16)).toFixed(1)}" fill="${col}" font-size="12" font-weight="700" text-anchor="middle">${txt}</text>`;
  const marcas = [];
  for (const [ts, txt] of [[t.t1, '1'], [t.t2, '2']]) {
    if (ts == null) continue;
    const i = iDe(ts);
    marcas.push(etiqueta(i, venta ? d.h[i] : d.l[i], txt, '#7fd4ff', venta));
  }
  const iEntrada = iDe(t.ts);
  marcas.push(`<circle cx="${X(iEntrada).toFixed(1)}" cy="${Y(t.e).toFixed(1)}" r="4.5" fill="#fff" stroke="#080c12" stroke-width="1.5"/>`);
  marcas.push(etiqueta(iEntrada, t.e, venta ? 'Vende' : 'Compra', '#fff', !venta));
  if (t.xt != null) {
    // xt es el cierre de la vela de salida; al romperse una M se sale en la apertura de la siguiente.
    const iSalida = iDe(t.mo === 'M' ? t.xt : t.xt - SPOT_MS);
    marcas.push(`<rect x="${(X(iSalida) - 4).toFixed(1)}" y="${(Y(t.x) - 4).toFixed(1)}" width="8" height="8" fill="${_paperCol(t.n)}" stroke="#080c12" stroke-width="1.5"/>`);
    marcas.push(etiqueta(iSalida, t.x, 'Salida', _paperCol(t.n), t.x >= t.e));
  }

  const fechas = [];
  const cada = Math.max(1, Math.round(d.n / 6));
  for (let i = 0; i < d.n; i += cada) fechas.push(`<text x="${X(i).toFixed(1)}" y="${H - 8}" fill="#d7dde8" font-size="11" text-anchor="middle">${new Date(d.t[i]).toISOString().slice(5, 10).replace('-', '/')}</text>`);

  const resultado = t.xt != null
    ? `${_SPOT_MOTIVO[t.mo] || 'salida'} en ${fmtPrice(t.x)} · neto <b style="color:${_paperCol(t.n)}">${_paperPct(t.n, 2)}</b> · ${_spotDias(t.xt - t.ts)}`
    : 'sigue abierta';
  return `<div class="sp-graf-cabeza">
      <b>${_paperEsc(_spotMoneda(t.s))}/USDT spot · 4h</b>
      <span>${venta ? 'Venta' : 'Compra'} en ${fmtPrice(t.e)} · ${_spotFecha(t.ts)} UTC · ${resultado}</span>
      <button class="pt-btn lab-a-la-derecha" onclick="spotCerrarGrafico()">Cerrar</button>
    </div>
    <div class="sp-graf-caja"><svg class="sp-graf" viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfico de ${_paperEsc(_spotMoneda(t.s))} con el patrón, los niveles, la entrada y la salida">
      ${lineas}${velas}${marcas.join('')}${textos}${fechas.join('')}
    </svg></div>`;
}
