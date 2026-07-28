/* public/main.js
 * Punto de entrada: cambio de pestañas, ciclo de carga, ordenación de la
 * tabla, countdown y arranque. DEBE cargarse el ÚLTIMO (llama a load()).
 */

// ── Tab switching ──────────────────────────────────────────────────────────
function switchTab(tab) {
  activeTab = tab;
  document.getElementById('screener-tab').style.display  = tab === 'screener'  ? ''     : 'none';
  document.getElementById('btc-tab').style.display       = tab === 'btc'       ? 'flex' : 'none';
  document.getElementById('strategy-tab').style.display  = tab === 'strategy'  ? 'flex' : 'none';
  document.getElementById('lab-tab').style.display       = tab === 'lab'       ? 'flex' : 'none';
  document.getElementById('tab-screener').classList.toggle('active', tab === 'screener');
  document.getElementById('tab-btc').classList.toggle('active',      tab === 'btc');
  document.getElementById('tab-strategy').classList.toggle('active', tab === 'strategy');
  document.getElementById('tab-lab').classList.toggle('active',      tab === 'lab');
  if (tab === 'screener' && allRows.length) requestAnimationFrame(() => renderMap());
  if (tab === 'btc'      && allRows.length) renderBTC();
  if (tab === 'strategy' && allRows.length) renderStrategy();
  if (tab === 'lab'      && allRows.length) renderLab();
}

// ── Data loading ───────────────────────────────────────────────────────────
async function load() {
  if (isLoading) return;
  isLoading = true;
  document.getElementById('loading-bar').classList.add('active');
  document.getElementById('refresh-btn').disabled = true;

  try {
    const json = await loadData();

    const firstLoad = allRows.length === 0;
    allRows = json.symbols || [];
    checkQuadrantChanges(allRows);
    recordTrails(allRows);
    _oiSigCache.clear();
    updateConfSignals(allRows); // calibración del radar: registra ≥4/5 y resuelve +30m/+1h
    updateMarketSentiment(allRows);
    renderRiskLight(); // semáforo de riesgo de mercado (header)
    renderQuadAligned(allRows); // barra "cuadrante alineado" bajo el mapa (y en Estrategia)
    renderOutlierStrip(allRows); // 🎯 outliers reales: dist real + liquidez + sostenido vs. pico
    renderMomentumStrip(allRows); // 🚀 momentum confirmado: umbrales absolutos precio 5% + OI 10%
    scanPatterns(allRows); // detector W/M + alertas de ruptura de cuello (antes de render: pinta badges)
    scanIndicatorConfluence(allRows); // 🧭 RSI/MACD/ADX/TSI/Andean en 15m: alertas 4/4 + evidencia
    btcOnCycle(); // ₿ direccionalidad BTC: factores, sesiones y alertas de cambio de sesgo
    if (firstLoad && allRows.length) connectLiqWS(allRows.map(r => r.symbol));
    countdownVal = 10;

    const ts = new Date(json.ts);
    const timeStr = ts.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    document.getElementById('meta').textContent = `Actualizado ${timeStr}`;
    document.getElementById('sym-count').textContent = allRows.length + ' pares';

    render();
    renderDetail(); // refresca el panel lateral si está abierto
    if (activeTab === 'screener') renderMap();
    if (activeTab === 'strategy') renderStrategy();
    if (activeTab === 'lab')      renderLab();
  } catch (e) {
    document.getElementById('meta').textContent = 'Error: ' + e.message;
  } finally {
    isLoading = false;
    document.getElementById('loading-bar').classList.remove('active');
    document.getElementById('refresh-btn').disabled = false;
  }
}

function forceRefresh() { countdownVal = 0; load(); }

// ── Sort ───────────────────────────────────────────────────────────────────
document.querySelectorAll('#thead th[data-col]').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (sortCol === col) sortDir *= -1;
    else { sortCol = col; sortDir = -1; }
    render();
  });
});

// ── Countdown + precio en vivo ─────────────────────────────────────────────
function tick() {
  countdownVal--;
  const el = document.getElementById('countdown');
  if (countdownVal <= 0) { el.textContent = '↻'; load(); }
  else el.textContent = countdownVal + 's';
  applyLiveTickers(); // precio/funding/OI del WS → tabla, cada segundo
}

// ── Boot ───────────────────────────────────────────────────────────────────
syncFromServer().then(() => {
  renderSeguimiento();
  backfillTrackHistory(); // rellena huecos de precio desde el servidor de snapshots
});
load();
setInterval(tick, 1000);
