/* public/indicators.js
 * 🧭 CONFLUENCIA DE INDICADORES — réplica del sistema del usuario en TradingView,
 * calculada sobre velas de 15m (k15, 96 velas = 24h) para las ~100 monedas.
 *
 * Criterios (los 4 core deben coincidir para dar señal):
 *   RSI(14)      > 50 alcista · < 50 bajista
 *   MACD(12,26)  línea MACD > 0 alcista · < 0 bajista
 *   ADX(14)      fuerza > 25 (key) Y dirección por DMI: +DI>−DI alcista · −DI>+DI bajista
 *   TSI(25,13)   > 0 acompañando la dirección · < 0 bajista
 *   Andean(50)   confirmación EXTRA (lenta, no obligatoria): bull>bear · bear>bull
 *
 * Ajusta los parámetros en IND_CFG si tu configuración de TradingView difiere.
 */

const IND_CFG = {
  rsiLen: 14,
  macdFast: 12, macdSlow: 26, macdSig: 9,
  adxLen: 14, adxKey: 25,
  tsiR: 25, tsiS: 13, tsiSig: 13,
  andLen: 50,
};

// ── Matemática (fórmulas estándar, mismas que TradingView) ──────────────────
function _emaArr(vals, len) {
  const out = new Array(vals.length).fill(null);
  if (vals.length < len) return out;
  let sum = 0;
  for (let i = 0; i < len; i++) sum += vals[i];
  let prev = sum / len;
  out[len - 1] = prev;
  const a = 2 / (len + 1);
  for (let i = len; i < vals.length; i++) { prev = vals[i] * a + prev * (1 - a); out[i] = prev; }
  return out;
}

function _rsiLast(closes, len) {
  if (closes.length < len + 2) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= len; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
  let ag = g / len, al = l / len;
  for (let i = len + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (len - 1) + Math.max(d, 0)) / len;
    al = (al * (len - 1) + Math.max(-d, 0)) / len;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

function _macdLast(closes, f, s, sg) {
  if (closes.length < s + sg + 5) return null;
  const eF = _emaArr(closes, f), eS = _emaArr(closes, s);
  const line = [];
  for (let i = 0; i < closes.length; i++) if (eF[i] != null && eS[i] != null) line.push(eF[i] - eS[i]);
  if (line.length < sg + 2) return null;
  const sig = _emaArr(line, sg);
  return { macd: line[line.length - 1], signal: sig[sig.length - 1], hist: line[line.length - 1] - sig[sig.length - 1] };
}

function _adxLast(k, len) {
  const n = k.c.length;
  if (n < len * 2 + 2) return null;
  const tr  = i => Math.max(k.h[i] - k.l[i], Math.abs(k.h[i] - k.c[i - 1]), Math.abs(k.l[i] - k.c[i - 1]));
  const dmP = i => { const up = k.h[i] - k.h[i - 1], dn = k.l[i - 1] - k.l[i]; return up > dn && up > 0 ? up : 0; };
  const dmM = i => { const up = k.h[i] - k.h[i - 1], dn = k.l[i - 1] - k.l[i]; return dn > up && dn > 0 ? dn : 0; };
  let trS = 0, pS = 0, mS = 0;
  for (let i = 1; i <= len; i++) { trS += tr(i); pS += dmP(i); mS += dmM(i); }
  let adx = null, dxSum = 0, dxCnt = 0, pdi = 0, mdi = 0;
  for (let i = len + 1; i < n; i++) {
    trS = trS - trS / len + tr(i);
    pS  = pS  - pS  / len + dmP(i);
    mS  = mS  - mS  / len + dmM(i);
    pdi = trS ? 100 * pS / trS : 0;
    mdi = trS ? 100 * mS / trS : 0;
    const dx = (pdi + mdi) ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0;
    if (adx == null) { dxSum += dx; dxCnt++; if (dxCnt === len) adx = dxSum / len; }
    else adx = (adx * (len - 1) + dx) / len;
  }
  return adx == null ? null : { adx, plusDI: pdi, minusDI: mdi };
}

function _tsiLast(closes, r, s, sg) {
  if (closes.length < r + s + sg + 5) return null;
  const mom = [], amom = [];
  for (let i = 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; mom.push(d); amom.push(Math.abs(d)); }
  const e1 = _emaArr(mom, r), e1a = _emaArr(amom, r);
  const v = [], va = [];
  for (let i = 0; i < e1.length; i++) if (e1[i] != null) { v.push(e1[i]); va.push(e1a[i]); }
  const e2 = _emaArr(v, s), e2a = _emaArr(va, s);
  const tsiArr = [];
  for (let i = 0; i < e2.length; i++) if (e2[i] != null && e2a[i]) tsiArr.push(100 * e2[i] / e2a[i]);
  if (tsiArr.length < 3) return null;
  const sig = _emaArr(tsiArr, sg);
  return { tsi: tsiArr[tsiArr.length - 1], signal: sig[sig.length - 1] };
}

// Andean Oscillator (alexgrover) — componentes alcista/bajista por envolventes
function _andeanLast(k, len) {
  const n = k.c.length;
  if (n < len + 10) return null;
  const a = 2 / (len + 1);
  let up1, up2, dn1, dn2;
  let bull = 0, bear = 0;
  for (let i = 0; i < n; i++) {
    const C = k.c[i], O = k.o[i], C2 = C * C, O2 = O * O;
    if (i === 0) { up1 = C; up2 = C2; dn1 = C; dn2 = C2; }
    else {
      up1 = Math.max(C, O, up1 - (up1 - C) * a);
      up2 = Math.max(C2, O2, up2 - (up2 - C2) * a);
      dn1 = Math.min(C, O, dn1 + (C - dn1) * a);
      dn2 = Math.min(C2, O2, dn2 + (C2 - dn2) * a);
    }
    bull = Math.sqrt(Math.max(0, dn2 - dn1 * dn1));
    bear = Math.sqrt(Math.max(0, up2 - up1 * up1));
  }
  return { bull, bear };
}

// ── Confluencia por símbolo ──────────────────────────────────────────────────
function indicatorConfluence(row) {
  const k = row.k15; // velas 15m (96 = 24h); mínimos: Andean 60, TSI 56, MACD 40
  if (!k?.c || k.c.length < 80) return null;
  const C = IND_CFG;
  const rsi = _rsiLast(k.c, C.rsiLen);
  const mac = _macdLast(k.c, C.macdFast, C.macdSlow, C.macdSig);
  const adx = _adxLast(k, C.adxLen);
  const tsi = _tsiLast(k.c, C.tsiR, C.tsiS, C.tsiSig);
  const and = _andeanLast(k, C.andLen);
  if (rsi == null || !mac || !adx || !tsi) return null;

  // dirección individual de cada indicador ('g' verde, 'r' rojo, 'n' neutro)
  const dirs = {
    rsi:  rsi > 50 ? 'g' : rsi < 50 ? 'r' : 'n',
    macd: mac.macd > 0 ? 'g' : mac.macd < 0 ? 'r' : 'n',
    adx:  adx.adx > C.adxKey ? (adx.plusDI > adx.minusDI ? 'g' : 'r') : 'n', // sin fuerza = neutro
    tsi:  tsi.tsi > 0 ? 'g' : tsi.tsi < 0 ? 'r' : 'n',
    and:  and ? (and.bull > and.bear ? 'g' : 'r') : 'n',
  };
  const core = [dirs.rsi, dirs.macd, dirs.adx, dirs.tsi];
  const nG = core.filter(d => d === 'g').length;
  const nR = core.filter(d => d === 'r').length;
  const side = nG === 4 ? 'long' : nR === 4 ? 'short' : null;
  const andeanOk = side ? (side === 'long' ? dirs.and === 'g' : dirs.and === 'r') : false;

  return { rsi, mac, adx, tsi, and, dirs, nG, nR, side, andeanOk };
}

// ── Escaneo por ciclo + alertas + registro en el Comparador ─────────────────
const _indPrev = new Map();      // sym → 'long'|'short'|null (transiciones)
const _indAlertAt = new Map();   // 'sym|side' → ts del último aviso (anti-parpadeo)
const IND_ALERT_COOLDOWN = 60 * 60_000; // 1h: si MACD/RSI oscila en el borde no re-avisa
let _indFirstScan = true;        // 1er ciclo tras cargar: registra estado SIN avisar

function scanIndicatorConfluence(rows) {
  const entries = [];
  for (const r of rows) {
    r.indConf = indicatorConfluence(r);
    const ic = r.indConf;
    const cur = ic?.side || null;
    if (cur) entries.push({ symbol: r.symbol, side: cur === 'long' ? 'l' : 's', score: ic.andeanOk ? 5 : 4 });

    const prev = _indPrev.get(r.symbol);
    const cdKey = cur ? `${r.symbol}|${cur}` : null;
    const cooled = cdKey ? Date.now() - (_indAlertAt.get(cdKey) || 0) > IND_ALERT_COOLDOWN : false;
    // Solo TRANSICIONES (no estados ya vigentes al cargar) + cooldown 1h por símbolo/lado
    if (cur && cur !== prev && !_indFirstScan && cooled && canAlert('indConf')) {
      const isL = cur === 'long';
      showToast(`🧭 ${r.symbol} — indicadores 4/4 ${isL ? 'ALCISTA' : 'BAJISTA'} (15m)${ic.andeanOk ? ' + Andean ✓' : ''}`, isL ? 'long' : 'short');
      if (soundEnabled) beep(isL ? 990 : 440, 'triangle', 200);
      notifyDesktop(
        `🧭 ${r.symbol} confluencia total ${isL ? 'ALCISTA' : 'BAJISTA'} (15m)`,
        `RSI ${ic.rsi.toFixed(0)} · MACD ${_fmtMacd(ic.mac.macd)} · ADX ${ic.adx.adx.toFixed(0)} (${isL ? '+DI' : '−DI'} dominante) · TSI ${ic.tsi.tsi.toFixed(1)}${ic.andeanOk ? ' · Andean ✓' : ''}`
      );
      _indAlertAt.set(cdKey, Date.now());
    }
    _indPrev.set(r.symbol, cur);
  }
  _indFirstScan = false;
  // Evidencia en el Comparador: misma vara que el resto de estrategias
  if (typeof logPanelDetections === 'function') logPanelDetections('indConf', entries);
}

// ── Render (sección en la pestaña Estrategia) ───────────────────────────────
function _indChip(name, dir, txt) {
  const cls = dir === 'g' ? 'ind-g' : dir === 'r' ? 'ind-r' : 'ind-n';
  return `<span class="ind-chip ${cls}">${name} ${txt}</span>`;
}

// MACD está en unidades de precio: en monedas de precio diminuto toFixed(2)
// mostraría "+0.00" — precisión adaptativa según magnitud
function _fmtMacd(v) {
  const a = Math.abs(v), s = v >= 0 ? '+' : '';
  if (a >= 1) return s + v.toFixed(1);
  if (a >= 0.01) return s + v.toFixed(3);
  return s + v.toPrecision(2);
}

function _indChipsHtml(ic) {
  const isL = ic.adx.plusDI > ic.adx.minusDI;
  return [
    _indChip('RSI', ic.dirs.rsi, ic.rsi.toFixed(1)),
    _indChip('MACD', ic.dirs.macd, _fmtMacd(ic.mac.macd)),
    _indChip('ADX', ic.dirs.adx, ic.adx.adx.toFixed(0) + (ic.dirs.adx === 'n' ? ' sin fuerza' : isL ? ' +DI' : ' −DI')),
    _indChip('TSI', ic.dirs.tsi, (ic.tsi.tsi >= 0 ? '+' : '') + ic.tsi.tsi.toFixed(1)),
    ic.and ? _indChip('Andean', ic.dirs.and, ic.dirs.and === 'g' ? 'bull' : 'bear') : '',
  ].join('');
}

function renderIndConf() {
  const grid = document.getElementById('indconf-grid');
  if (!grid) return;

  // ₿ BTC siempre visible con su semáforo completo (aunque no haya 4/4)
  const btcEl = document.getElementById('indconf-btc');
  const btc = allRows.find(r => r.symbol === 'BTC');
  if (btcEl) {
    const ic = btc?.indConf;
    if (!ic) btcEl.innerHTML = '<span class="lr-empty">Calculando indicadores de BTC…</span>';
    else {
      const verdict = ic.side
        ? `<b style="color:${ic.side === 'long' ? '#2fe08a' : '#ff5555'}">4/4 ${ic.side === 'long' ? 'ALCISTA ▲' : 'BAJISTA ▼'}${ic.andeanOk ? ' + Andean ✓' : ''}</b>`
        : `<span style="color:#8aa0c8">mixto — ${ic.nG} verde / ${ic.nR} rojo${ic.dirs.adx === 'n' ? ' · ADX sin fuerza (<' + IND_CFG.adxKey + ')' : ''}</span>`;
      btcEl.innerHTML = `<span class="indc-sym">₿ BTC</span> ${_indChipsHtml(ic)} <span class="indc-verdict">${verdict}</span>`;
    }
  }

  const full = allRows.filter(r => r.indConf?.side)
    .sort((a, b) => (b.indConf.andeanOk - a.indConf.andeanOk) || (b.indConf.adx.adx - a.indConf.adx.adx));

  const cnt = document.getElementById('indconf-count');
  if (cnt) {
    const nL = full.filter(r => r.indConf.side === 'long').length;
    const nS = full.length - nL;
    let txt = full.length ? `${nL} alcistas · ${nS} bajistas` : '';
    if (typeof strategyEvidence === 'function') {
      const ev = strategyEvidence('indConf');
      if (ev && ev.n >= 10) txt += `${txt ? ' · ' : ''}histórico: ${ev.winRate}% a 1h (n=${ev.n})`;
    }
    cnt.textContent = txt;
  }

  if (!full.length) {
    grid.innerHTML = '<div class="cc-note">Ninguna moneda con los 4 indicadores alineados en 1h ahora mismo — la confluencia total es poco frecuente por diseño: cuando aparezca, vale la pena mirarla.</div>';
    return;
  }

  grid.innerHTML = full.slice(0, 12).map(r => {
    const ic = r.indConf;
    const isL = ic.side === 'long';
    // ATR de 1h escalado a 15m (×√0.25): stops acordes a la temporalidad de la señal
    const atrP = r.atr1h && r.price ? (r.atr1h / r.price) * 0.5 : null;
    const dirn = isL ? 1 : -1;
    const lvl = atrP
      ? `<div class="cc-lvls">entra <b>${fmtPrice(r.price)}</b> · stop <b class="neg">${fmtPrice(r.price * (1 - dirn * atrP * 1.2))}</b> · TP <b class="pos">${fmtPrice(r.price * (1 + dirn * atrP * 1.8))}</b></div>`
      : '';
    return `<div class="indc-card ${isL ? 'indc-long' : 'indc-short'}" onclick="openDetail('${r.symbol}')">
      <div class="indc-head">
        <span class="indc-sym">${r.symbol}</span>
        <span class="cc-side ${isL ? 'long' : 'short'}">${isL ? 'LONG' : 'SHORT'}</span>
        <span class="indc-badge">${ic.andeanOk ? '5/5 🔥' : '4/4'}</span>
      </div>
      <div class="indc-chips">${_indChipsHtml(ic)}</div>
      ${lvl}
    </div>`;
  }).join('');
}
