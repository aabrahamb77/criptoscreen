require('dotenv').config();
const express = require('express');
const compression = require('compression');
const path = require('path');
const db = require('./db');
const ai = require('./ai');
const lxrBot = require('./bot');

const app = express();
// gzip en TODAS las respuestas (HTML/JS/CSS/JSON). El index.html (~200 KB) y el
// JSON de /api/bot/stats bajan ~5-10x → clave para no reventar el ancho de banda
// del plan gratis de Render.
app.use(compression());
app.use(express.json({ limit: '10mb' }));
// Cache en el navegador: el HTML revalida (304 si no cambió, casi 0 bytes) y los
// assets (js/css/img) se cachean 1h para no re-descargarse en cada navegación.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', filePath.endsWith('.html') ? 'no-cache' : 'public, max-age=3600');
  },
}));

// Auth opcional: si defines API_TOKEN en .env, los endpoints /api/* exigen
// "Authorization: Bearer <token>". Sin API_TOKEN no cambia nada (uso local).
// Útil solo si expones el server fuera de localhost.
const API_TOKEN = process.env.API_TOKEN;
app.use('/api', (req, res, next) => {
  if (!API_TOKEN) return next();
  if ((req.headers.authorization || '') === `Bearer ${API_TOKEN}`) return next();
  res.status(401).json({ error: 'no autorizado' });
});

// Rate limit simple en memoria (sin dependencias): max peticiones por IP/ventana.
const _hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const arr = (_hits.get(req.ip) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'demasiadas peticiones, espera un momento' });
    arr.push(now);
    _hits.set(req.ip, arr);
    next();
  };
}

if (process.env.LXR_BOT === '1') lxrBot.startBot();

// Respaldo en servidor de trackHistory + stratSignals (Turso). Si no está
// configurado, responde 204/{} para que el frontend siga usando solo localStorage.
app.get('/api/sync', async (req, res) => {
  if (!db.enabled()) return res.json(null);
  try {
    const data = await db.loadSync();
    res.json(data);
  } catch (err) {
    console.error('GET /api/sync error:', err.message);
    res.status(500).json({ error: 'sync read failed' });
  }
});

app.post('/api/sync', async (req, res) => {
  if (!db.enabled()) return res.status(204).end();
  try {
    const { trackHistory, stratSignals, trackLedger, favorites, confSignals } = req.body || {};
    if (typeof trackHistory !== 'object' || !Array.isArray(stratSignals)) {
      return res.status(400).json({ error: 'invalid payload' });
    }
    await db.saveSync(trackHistory, stratSignals, Array.isArray(trackLedger) ? trackLedger : [], Array.isArray(favorites) ? favorites : [], Array.isArray(confSignals) ? confSignals : []);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/sync error:', err.message);
    res.status(500).json({ error: 'sync write failed' });
  }
});

// Explica en lenguaje natural el contexto de una moneda ya calculado en el
// frontend (heat score, confluencia, régimen, alineación, playbook, etc.).
// Si no hay ANTHROPIC_API_KEY, responde 503 y el frontend lo muestra como
// "función no configurada" sin romper nada.
app.post('/api/explain', rateLimit(10, 60_000), async (req, res) => {
  if (!ai.enabled()) return res.status(503).json({ error: 'IA no configurada (falta ANTHROPIC_API_KEY)' });
  try {
    const ctx = req.body || {};
    if (!ctx.symbol) return res.status(400).json({ error: 'falta symbol' });
    const text = await ai.explain(ctx);
    res.json({ text });
  } catch (err) {
    console.error('POST /api/explain error:', err.message);
    res.status(500).json({ error: 'explain failed' });
  }
});

app.get('/api/bot/stats', (req, res) => res.json(lxrBot.getState()));
app.post('/api/bot/reset', (req, res) => res.json(lxrBot.resetBreaker()));
app.post('/api/bot/start', async (req, res) => {
  try {
    const botState = await lxrBot.startBot();
    res.json({ ok: true, started: botState.started });
  } catch (err) {
    console.error('POST /api/bot/start error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Screener → http://localhost:${PORT}`));
