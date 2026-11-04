/* public/calc.js
 * 🧮 Calculadora de posición: cuánto entrar para perder solo lo decidido si salta el stop.
 *
 *   posición = riesgo en dólares ÷ (distancia al stop + comisión de ida y vuelta)
 *
 * La comisión va dentro del riesgo porque se paga sobre la posición, no sobre el margen: con
 * un stop de 0,3% se lleva casi un tercio de lo que se arriesga.
 *
 * El apalancamiento no cambia cuánto se gana o se pierde, solo cuánto margen se bloquea y a
 * qué distancia está la liquidación. Se recomienda el mayor que deje el stop a menos de la
 * mitad de esa distancia, con un tope de 10x. La liquidación es aproximada: en Bybit depende
 * de la moneda y del tamaño. Requiere lab.js (comisiones) y core.js (safeSetItem, fmtPrice).
 */

const CALC_MMR       = 0.5;   // margen de mantenimiento aproximado: a 10x liquida a −9,5%
const CALC_PALANCAS  = [1, 2, 3, 5, 10];
const CALC_OPCIONES  = [1, 2, 3, 5, 10, 15, 20, 25, 50];
const CALC_RIESGO_ALTO = 2;   // % por operación: en la simulación, más de la mitad de la cuenta en caídas

let _calcCfg = (() => {
  const base = { capital: 1000, riesgo: 0.5, lev: 0 };   // lev 0 = el recomendado
  try { return { ...base, ...JSON.parse(localStorage.getItem('scalp_calc') || '{}') }; } catch (_) { return base; }
})();

function calcPalancaMax(stopPct) {
  const tope = 100 / (2 * stopPct + CALC_MMR);
  return CALC_PALANCAS.filter(x => x <= tope).pop() || 1;
}

function calcPosicion({ capital, riesgoPct, entrada, stop, objetivo, lev }) {
  if (!(capital > 0)) return { error: 'Escribe tu capital.' };
  if (!(riesgoPct > 0)) return { error: 'Escribe cuánto quieres arriesgar por operación.' };
  if (!(entrada > 0) || !(stop > 0)) return { error: 'Escribe la entrada y el stop.' };
  if (entrada === stop) return { error: 'La entrada y el stop no pueden ser el mismo precio.' };

  const dir = entrada > stop ? 1 : -1;
  const stopPct = Math.abs(entrada - stop) / entrada * 100;
  const mercado = FEE_TAKER_PCT + SLIP_PCT;
  const comStop = 2 * mercado, comObjetivo = mercado + FEE_MAKER_PCT;

  const riesgo = capital * riesgoPct / 100;
  const posicion = riesgo / ((stopPct + comStop) / 100);
  const palancaMax = calcPalancaMax(stopPct);
  const palanca = lev > 0 ? lev : palancaMax;
  const margen = posicion / palanca;
  const liqPct = 100 / palanca - CALC_MMR;

  const r = {
    dir, lado: dir > 0 ? 'LONG' : 'SHORT', stopPct, riesgo, posicion, cantidad: posicion / entrada,
    palanca, palancaMax, margen, margenPct: margen / capital * 100, liqPct,
    liqPrecio: entrada * (1 - dir * liqPct / 100), comision: posicion * comStop / 100,
    ganancia: null, multiplo: null, objetivoMal: false,
  };

  if (objetivo > 0) {
    const objPct = dir * (objetivo - entrada) / entrada * 100;
    if (objPct <= 0) r.objetivoMal = true;
    else {
      r.ganancia = posicion * (objPct - comObjetivo) / 100;
      r.multiplo = r.ganancia / riesgo;
    }
  }

  if (stopPct >= liqPct) {
    r.estado = 'peligro';
    r.mensaje = `A ${palanca}x te liquidarían (−${liqPct.toFixed(1)}%) antes de que salte el stop (−${stopPct.toFixed(1)}%). Usa ${palancaMax}x como máximo.`;
  } else if (margen > capital) {
    r.estado = 'peligro';
    r.mensaje = `Esta posición pide ${_calcDolares(margen)} de margen y tu cuenta es de ${_calcDolares(capital)}. Baja el riesgo o aleja el stop.`;
  } else if (palanca > palancaMax) {
    r.estado = 'aviso';
    r.mensaje = `A ${palanca}x el stop queda muy cerca de la liquidación. Mejor ${palancaMax}x o menos.`;
  } else if (riesgoPct > CALC_RIESGO_ALTO) {
    r.estado = 'aviso';
    r.mensaje = `Arriesgas más del ${CALC_RIESGO_ALTO}% por operación: en la simulación, eso llevó a caídas de más de la mitad de la cuenta.`;
  } else {
    r.estado = 'ok';
    r.mensaje = 'El stop salta mucho antes de la liquidación.';
  }
  return r;
}

const _calcDolares = v => `$${v >= 1000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2)}`;
const _calcCantidad = q => (q >= 1000 ? Math.round(q).toLocaleString('en-US') : q >= 1 ? q.toFixed(3) : q.toPrecision(3));
const _calcNum = id => {
  const el = document.getElementById(id);
  return el ? parseFloat(String(el.value).replace(',', '.')) : NaN;
};

// ── Interfaz ────────────────────────────────────────────────────────────────
let _calcMoneda = '';

function _calcPintarForm() {
  const el = document.getElementById('calc-panel');
  if (!el) return;
  const opciones = [`<option value="0"${_calcCfg.lev ? '' : ' selected'}>Recomendado</option>`,
    ...CALC_OPCIONES.map(x => `<option value="${x}"${_calcCfg.lev === x ? ' selected' : ''}>${x}x</option>`)].join('');
  el.innerHTML = `
    <div class="calc-cab">
      <b>🧮 Calculadora de posición</b>
      <button class="calc-cerrar" onclick="calcCerrar()" aria-label="Cerrar la calculadora">✕</button>
    </div>
    <div class="calc-campos">
      <label>Tu capital ($)<input id="calc-capital" type="number" min="0" step="any" inputmode="decimal" value="${_calcCfg.capital}" onfocus="this.select()" oninput="calcActualizar()"></label>
      <label>Riesgo por operación (%)<input id="calc-riesgo" type="number" min="0" step="0.05" inputmode="decimal" value="${_calcCfg.riesgo}" onfocus="this.select()" oninput="calcActualizar()"></label>
      <label>Entrada<input id="calc-entrada" type="number" min="0" step="any" inputmode="decimal" onfocus="this.select()" oninput="calcActualizar()"></label>
      <label>Stop<input id="calc-stop" type="number" min="0" step="any" inputmode="decimal" onfocus="this.select()" oninput="calcActualizar()"></label>
      <label>Objetivo (opcional)<input id="calc-objetivo" type="number" min="0" step="any" inputmode="decimal" onfocus="this.select()" oninput="calcActualizar()"></label>
      <label>Apalancamiento<select id="calc-lev" onchange="calcActualizar()">${opciones}</select></label>
    </div>
    <div id="calc-res"></div>`;
}

function calcActualizar() {
  const res = document.getElementById('calc-res');
  if (!res) return;
  const capital = _calcNum('calc-capital'), riesgoPct = _calcNum('calc-riesgo'), lev = _calcNum('calc-lev') || 0;
  if (capital > 0 && riesgoPct > 0) {
    _calcCfg = { capital, riesgo: riesgoPct, lev };
    safeSetItem('scalp_calc', JSON.stringify(_calcCfg));
  }
  const r = calcPosicion({ capital, riesgoPct, entrada: _calcNum('calc-entrada'), stop: _calcNum('calc-stop'), objetivo: _calcNum('calc-objetivo'), lev });
  if (r.error) { res.innerHTML = `<div class="calc-vacio">${r.error}</div>`; return; }
  const col = r.dir > 0 ? '#2fe08a' : '#ff6680';
  res.innerHTML = `
    <div class="calc-grande">
      <span><b class="calc-lado" style="color:${col}">${_calcMoneda ? _calcMoneda + ' · ' : ''}${r.lado}</b> · entra con</span>
      <b class="calc-monto">${_calcDolares(r.posicion)}</b>
      <span>${_calcCantidad(r.cantidad)} ${_calcMoneda || 'unidades'}</span>
    </div>
    <div class="calc-fila"><span>Margen a ${r.palanca}x</span><b>${_calcDolares(r.margen)} (${r.margenPct.toFixed(1)}% de la cuenta)</b></div>
    <div class="calc-fila"><span>Si salta el stop (−${r.stopPct.toFixed(2)}%)</span><b style="color:#ff6680">−${_calcDolares(r.riesgo)}</b></div>
    ${r.ganancia != null ? `<div class="calc-fila"><span>Si llega al objetivo</span><b style="color:${r.ganancia >= 0 ? '#2fe08a' : '#ff6680'}">${r.ganancia >= 0 ? '+' : '−'}${_calcDolares(Math.abs(r.ganancia))} (${r.multiplo.toFixed(1)} R)</b></div>` : ''}
    ${r.objetivoMal ? '<div class="calc-fila"><span>Objetivo</span><b style="color:#ffd76a">Está del lado del stop</b></div>' : ''}
    <div class="calc-fila"><span>Comisión incluida</span><b>${_calcDolares(r.comision)}</b></div>
    <div class="calc-fila"><span>Liquidación aproximada</span><b>${fmtPrice(r.liqPrecio)} (−${r.liqPct.toFixed(1)}%)</b></div>
    <div class="calc-estado calc-${r.estado}">${r.mensaje}</div>`;
}

function calcCerrar() {
  const el = document.getElementById('calc-panel');
  if (el) el.hidden = true;
}

function calcAbrir() {
  const el = document.getElementById('calc-panel');
  if (!el) return;
  if (!el.hidden) { calcCerrar(); return; }
  el.hidden = false;
  if (!document.getElementById('calc-res')) _calcPintarForm();
  calcActualizar();
}

// Desde un patrón: rellena los niveles y deja que se puedan retocar.
function calcDesde(moneda, entrada, stop, objetivo) {
  const el = document.getElementById('calc-panel');
  if (!el) return;
  el.hidden = false;
  if (!document.getElementById('calc-res')) _calcPintarForm();
  _calcMoneda = moneda || '';
  const pon = (id, v) => { const c = document.getElementById(id); if (c) c.value = v > 0 ? Number(v.toPrecision(8)) : ''; };
  pon('calc-entrada', entrada); pon('calc-stop', stop); pon('calc-objetivo', objetivo);
  calcActualizar();
}
