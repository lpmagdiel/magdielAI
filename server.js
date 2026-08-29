require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 }
});

const API_KEY = process.env.API_KEY;
const MODEL = process.env.MODEL || 'MiniMax-M3';
const PORT = Number(process.env.PORT) || 3000;
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 120000;
const THINKING = process.env.THINKING;

let API_BASE_URL = (process.env.API_BASE_URL || '').replace(/\/+$/, '');
API_BASE_URL = API_BASE_URL.replace(/\/chat\/completions$/, '');

if (!API_KEY || !API_BASE_URL) {
  console.error('Falta API_KEY o API_BASE_URL en .env');
  process.exit(1);
}

console.log(`[boot] base=${API_BASE_URL}/chat/completions model=${MODEL} timeout=${UPSTREAM_TIMEOUT_MS}ms`);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

app.get('/manifest.webmanifest', (_req, res) => {
  res.type('application/manifest+json').sendFile(path.join(__dirname, 'public', 'manifest.webmanifest'));
});

app.get('/sw.js', (_req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.type('application/javascript').sendFile(path.join(__dirname, 'public', 'sw.js'));
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model: MODEL, base: API_BASE_URL });
});

app.post('/api/chat', upload.array('images', 5), async (req, res) => {
  const t0 = Date.now();
  console.log(`[chat] <- POST message="${(req.body.message || '').slice(0, 60)}" images=${(req.files || []).length}`);
  const message = (req.body.message || '').trim();
  const files = req.files || [];
  let history = [];
  try {
    if (req.body.history) history = JSON.parse(req.body.history);
  } catch (_) {}

  if (!message && files.length === 0) {
    return res.status(400).json({ error: 'Envía un mensaje o imágenes.' });
  }

  const userParts = [];
  if (message) userParts.push({ type: 'text', text: message });
  for (const file of files) {
    if (!file.mimetype.startsWith('image/')) continue;
    const dataUrl = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
    userParts.push({ type: 'image_url', image_url: { url: dataUrl } });
  }

  const userContent = userParts.length === 1 && userParts[0].type === 'text'
    ? userParts[0].text
    : userParts;

  const messages = [
    ...history.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : m.content,
    })),
    { role: 'user', content: userContent },
  ];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (obj) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    console.log(`[chat] -> ${API_BASE_URL}/chat/completions model=${MODEL} stream=true thinking=${THINKING || 'default'}`);
    const payload = { model: MODEL, messages, stream: true };
    if (THINKING === 'disabled' || THINKING === 'adaptive') {
      payload.thinking = { type: THINKING };
    }
    const upstream = await fetch(`${API_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const finalize = () => {
      clearTimeout(timer);
      console.log(`[chat] !! done in ${Date.now() - t0}ms status=${upstream.status}`);
    };

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      finalize();
      console.log(`[chat] xx upstream ${upstream.status}: ${errText.slice(0, 200)}`);
      try { send({ error: `API ${upstream.status}: ${errText.slice(0, 500)}` }); } catch (_) {}
      try { send({ done: true }); } catch (_) {}
      return res.end();
    }

    const ctype = upstream.headers.get('content-type') || '';
    if (!ctype.includes('text/event-stream')) {
      finalize();
      const json = await upstream.json().catch(() => ({}));
      const text = json?.choices?.[0]?.message?.content || '';
      console.log(`[chat] non-stream response, content_length=${text.length}`);
      if (text) send({ delta: text });
      send({ done: true });
      return res.end();
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sentAny = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') {
          finalize();
          send({ done: true });
          return res.end();
        }
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (delta) {
            sentAny = true;
            send({ delta });
          }
        } catch (_) {}
      }
    }
    finalize();
    if (!sentAny) console.log('[chat] !! upstream streamed no deltas');
    send({ done: true });
    res.end();
  } catch (err) {
    const msg = err.name === 'AbortError' ? `Tiempo de espera agotado (${UPSTREAM_TIMEOUT_MS / 1000}s)` : (err.message || 'Error desconocido');
    console.log(`[chat] !! error: ${msg}`);
    try { send({ error: msg }); } catch (_) {}
    try { send({ done: true }); } catch (_) {}
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Chat MiniMax en http://localhost:${PORT}`);
});
