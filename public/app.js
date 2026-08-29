const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => Array.from(p.querySelectorAll(s));

const messagesEl = $('#messages');
const composer = $('#composer');
const input = $('#input');
const sendBtn = $('#sendBtn');
const likeBtn = null;
const addBtn = $('#addBtn');
const fileInput = $('#fileInput');
const previewBar = $('#previewBar');
const previewsEl = $('#previews');
const clearPreviews = $('#clearPreviews');
const callBtn = $('#callBtn');
const statusEl = $('#status');

const history = [];
let pendingFiles = [];
let sending = false;
let currentAssistantBubble = null;
let currentAssistantText = '';
let renderTimer = null;
let recognition = null;
let callMode = false;
let speechBuffer = '';
let cachedVoice = undefined;

if (window.marked) {
  window.marked.setOptions({ breaks: true, gfm: true });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function markdownToHtml(text) {
  if (!window.marked) return escapeHtml(text).replace(/\n/g, '<br>');
  return window.marked.parse(escapeHtml(text));
}

function stripMarkdown(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<https?:\/\/[^>]+>/g, (m) => m.slice(1, -1).replace(/^https?:\/\//, ''))
    .replace(/^---+$|^\*\*\*+$|^___+$/gm, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+[.)]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
    .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\|/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nowLabel() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dayLabel() {
  return new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

function ensureDayDivider() {
  const last = messagesEl.lastElementChild;
  if (last && last.classList.contains('day-divider')) return;
  const d = document.createElement('div');
  d.className = 'day-divider';
  d.textContent = dayLabel();
  messagesEl.appendChild(d);
}

function buildRow({ role, text, images }) {
  ensureDayDivider();
  const row = document.createElement('div');
  row.className = `row ${role}`;

  const mini = document.createElement('div');
  mini.className = 'mini-avatar';
  mini.textContent = role === 'me' ? 'Tú' : 'AI';
  row.appendChild(mini);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (images && images.length) {
    bubble.classList.add('images');
    const grid = document.createElement('div');
    grid.className = 'img-grid';
    for (const src of images) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = 'imagen';
      grid.appendChild(img);
    }
    bubble.appendChild(grid);
    if (text) {
      const t = document.createElement('div');
      t.style.marginTop = '6px';
      t.style.padding = '0 6px';
      t.textContent = text;
      bubble.appendChild(t);
    }
  } else {
    bubble.textContent = text || '';
  }

  const meta = document.createElement('div');
  meta.className = 'meta-line';
  meta.textContent = nowLabel();
  bubble.appendChild(meta);

  row.appendChild(bubble);
  messagesEl.appendChild(row);
  scrollToBottom();
  return { row, bubble };
}

function addUserMessage({ text, images }) {
  const { bubble } = buildRow({ role: 'me', text, images });
  history.push({
    role: 'user',
    content: images && images.length
      ? [
          ...(text ? [{ type: 'text', text }] : []),
          ...images.map((src) => ({ type: 'image_url', image_url: { url: src } })),
        ]
      : text,
  });
  return bubble;
}

function startAssistantMessage() {
  ensureDayDivider();
  const row = document.createElement('div');
  row.className = 'row them';

  const mini = document.createElement('div');
  mini.className = 'mini-avatar';
  mini.textContent = 'AI';
  row.appendChild(mini);

  currentAssistantBubble = document.createElement('div');
  currentAssistantBubble.className = 'bubble';
  currentAssistantText = '';

  const typing = document.createElement('span');
  typing.className = 'typing';
  typing.innerHTML = '<span></span><span></span><span></span>';
  currentAssistantBubble.appendChild(typing);

  row.appendChild(currentAssistantBubble);
  messagesEl.appendChild(row);
  scrollToBottom();
}

function appendAssistantDelta(delta) {
  if (!currentAssistantBubble) return;
  const typingEl = currentAssistantBubble.querySelector('.typing');
  if (typingEl) typingEl.remove();

  currentAssistantText += delta;
  let textNode = currentAssistantBubble.querySelector('.text');
  if (!textNode) {
    textNode = document.createElement('div');
    textNode.className = 'text md';
    currentAssistantBubble.insertBefore(textNode, currentAssistantBubble.firstChild);
  }
  scheduleMdRender();

  if (!currentAssistantBubble.querySelector('.meta-line')) {
    const meta = document.createElement('div');
    meta.className = 'meta-line';
    meta.textContent = nowLabel();
    currentAssistantBubble.appendChild(meta);
  }

  if (callMode) {
    speechBuffer += delta;
    processSpeechBuffer(false);
    setVoiceStatus();
  }

  scrollToBottom();
}

function scheduleMdRender() {
  if (renderTimer || !currentAssistantBubble) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    const node = currentAssistantBubble?.querySelector('.text');
    if (!node) return;
    node.innerHTML = markdownToHtml(currentAssistantText);
  }, 50);
}

function showInlineError(message) {
  if (!currentAssistantBubble) return;
  const typingEl = currentAssistantBubble.querySelector('.typing');
  if (typingEl) typingEl.remove();
  let textNode = currentAssistantBubble.querySelector('.text');
  if (!textNode) {
    textNode = document.createElement('div');
    textNode.className = 'text';
    currentAssistantBubble.insertBefore(textNode, currentAssistantBubble.firstChild);
  }
  textNode.textContent = `⚠️ ${message}`;
  textNode.style.color = '#a00';
  currentAssistantBubble.style.background = '#ffe5e5';
  if (!currentAssistantBubble.querySelector('.meta-line')) {
    const meta = document.createElement('div');
    meta.className = 'meta-line';
    meta.textContent = nowLabel();
    currentAssistantBubble.appendChild(meta);
  }
  currentAssistantText = '';
  scrollToBottom();
}

function finishAssistantMessage() {
  if (!currentAssistantBubble) return;
  const typingEl = currentAssistantBubble.querySelector('.typing');
  if (typingEl) typingEl.remove();
  if (!currentAssistantText) {
    let textNode = currentAssistantBubble.querySelector('.text');
    if (!textNode) {
      textNode = document.createElement('div');
      textNode.className = 'text';
      textNode.style.opacity = '0.6';
      currentAssistantBubble.insertBefore(textNode, currentAssistantBubble.firstChild);
    }
    textNode.textContent = '(sin respuesta)';
    if (!currentAssistantBubble.querySelector('.meta-line')) {
      const meta = document.createElement('div');
      meta.className = 'meta-line';
      meta.textContent = nowLabel();
      currentAssistantBubble.appendChild(meta);
    }
  }
  if (currentAssistantText) {
    history.push({ role: 'assistant', content: currentAssistantText });
  }
  currentAssistantBubble = null;
  currentAssistantText = '';
  scrollToBottom();
  if (callMode) {
    processSpeechBuffer(true);
    setVoiceStatus();
    waitSpeechEndThenListen();
  }
}

function updateSendButton() {
  const hasText = input.value.trim().length > 0;
  const hasImages = pendingFiles.length > 0;
  sendBtn.disabled = !(hasText || hasImages) || sending;
}

function autoResize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}

function renderPreviews() {
  previewsEl.innerHTML = '';
  if (!pendingFiles.length) {
    previewBar.hidden = true;
    updateSendButton();
    return;
  }
  previewBar.hidden = false;
  pendingFiles.forEach((file, i) => {
    const url = URL.createObjectURL(file);
    const wrap = document.createElement('div');
    wrap.className = 'preview';
    const img = document.createElement('img');
    img.src = url;
    img.alt = file.name;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'rm';
    rm.textContent = '×';
    rm.title = 'Quitar';
    rm.addEventListener('click', () => {
      pendingFiles.splice(i, 1);
      renderPreviews();
    });
    wrap.appendChild(img);
    wrap.appendChild(rm);
    previewsEl.appendChild(wrap);
  });
  updateSendButton();
}

async function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function send() {
  if (sending) return;
  const text = input.value.trim();
  const files = pendingFiles.slice();
  if (!text && !files.length) return;

  sending = true;
  updateSendButton();
  input.value = '';
  autoResize();

  const objectUrls = files.map((f) => URL.createObjectURL(f));
  const dataUrls = await Promise.all(files.map(readFileAsDataURL));
  addUserMessage({ text, images: objectUrls });
  objectUrls.forEach((u) => URL.revokeObjectURL(u));

  pendingFiles = [];
  renderPreviews();

  startAssistantMessage();

  try {
    const fd = new FormData();
    fd.append('message', text);
    fd.append('history', JSON.stringify(history.slice(0, -1)));
    for (const f of files) fd.append('images', f, f.name);

    const res = await fetch('/api/chat', { method: 'POST', body: fd });
    if (!res.ok || !res.body) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt || 'sin respuesta'}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';
      for (const ev of events) {
        const line = ev.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          const data = JSON.parse(payload);
          if (data.error) {
            showInlineError(data.error);
          }
          if (typeof data.delta === 'string' && data.delta) {
            appendAssistantDelta(data.delta);
          }
          if (data.done) {
            finishAssistantMessage();
            sending = false;
            updateSendButton();
            return;
          }
        } catch (_) {}
      }
    }
    finishAssistantMessage();
  } catch (err) {
    showInlineError(err.message || String(err));
    finishAssistantMessage();
  } finally {
    sending = false;
    updateSendButton();
  }
}

addBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  const list = Array.from(fileInput.files || []);
  const onlyImages = list.filter((f) => f.type.startsWith('image/'));
  pendingFiles = pendingFiles.concat(onlyImages).slice(0, 5);
  fileInput.value = '';
  renderPreviews();
});

clearPreviews.addEventListener('click', () => {
  pendingFiles = [];
  renderPreviews();
});

input.addEventListener('input', () => {
  autoResize();
  updateSendButton();
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) send();
  }
});

composer.addEventListener('submit', (e) => {
  e.preventDefault();
  send();
});

likeBtn?.addEventListener?.('click', () => {
  if (sending) return;
  input.value = '❤️';
  autoResize();
  updateSendButton();
  send();
});

addEventListener('paste', (e) => {
  const items = Array.from(e.clipboardData?.items || []);
  const imgs = [];
  for (const it of items) {
    if (it.kind === 'file') {
      const f = it.getAsFile();
      if (f && f.type.startsWith('image/')) imgs.push(f);
    }
  }
  if (imgs.length) {
    e.preventDefault();
    pendingFiles = pendingFiles.concat(imgs).slice(0, 5);
    renderPreviews();
  }
});

function setStatus(text, pulse) {
  statusEl.innerHTML = pulse
    ? `<span class="dot pulse"></span>${escapeHtml(text)}`
    : `<span class="dot"></span>${escapeHtml(text)}`;
}

function setCallVisual(on) {
  callBtn.classList.toggle('listening', on);
  callBtn.title = on ? 'Terminar llamada' : 'Iniciar llamada por voz';
}

function startVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    showInlineError('Tu navegador no soporta reconocimiento de voz. Prueba Chrome o Edge.');
    callMode = false;
    setCallVisual(false);
    setStatus('Activo ahora', false);
    return;
  }
  try {
    recognition = new SR();
    recognition.lang = 'es-ES';
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;

    recognition.onresult = (e) => {
      const text = (e.results[0]?.[0]?.transcript || '').trim();
      if (text) {
        input.value = text;
        autoResize();
        updateSendButton();
      }
    };

    recognition.onerror = (e) => {
      let msg = `Error de voz: ${e.error}`;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') msg = 'Permiso de micrófono denegado';
      if (e.error === 'no-speech') msg = 'No te escuché, inténtalo de nuevo';
      if (e.error === 'audio-capture') msg = 'No se encontró micrófono';
      showInlineError(msg);
      callMode = false;
      setCallVisual(false);
      setStatus('Activo ahora', false);
      recognition = null;
    };

    recognition.onend = () => {
      recognition = null;
      if (!callMode) {
        setStatus('Activo ahora', false);
        return;
      }
      const text = input.value.trim();
      if (text && !sending) {
        send();
      } else {
        try { startVoice(); } catch (_) {}
      }
    };

    recognition.start();
    setStatus('Escuchando...', true);
  } catch (err) {
    showInlineError(`No se pudo iniciar el micrófono: ${err.message || err}`);
    callMode = false;
    setCallVisual(false);
    setStatus('Activo ahora', false);
  }
}

function toggleCall() {
  if (callMode) {
    callMode = false;
    setCallVisual(false);
    speechBuffer = '';
    if ('speechSynthesis' in window) {
      try { speechSynthesis.cancel(); } catch (_) {}
    }
    if (recognition) {
      try { recognition.stop(); } catch (_) {}
    } else {
      setStatus('Activo ahora', false);
    }
  } else {
    callMode = true;
    setCallVisual(true);
    if ('speechSynthesis' in window) {
      getVoices().then((v) => { cachedVoice = pickVoiceSync(v) ?? null; });
    }
    startVoice();
  }
}

function pickVoiceSync(voices) {
  if (!voices || !voices.length) return null;
  return (
    voices.find((v) => v.lang.toLowerCase() === 'es-es') ||
    voices.find((v) => v.lang.toLowerCase().startsWith('es-es')) ||
    voices.find((v) => /^es[-_]/i.test(v.lang)) ||
    voices.find((v) => /es/i.test(v.lang)) ||
    voices.find((v) => v.default) ||
    voices[0] ||
    null
  );
}

callBtn.addEventListener('click', toggleCall);

function setVoiceStatus() {
  if (!callMode) return;
  const ttsActive = ('speechSynthesis' in window) && speechSynthesis.speaking;
  const micActive = !!recognition;
  if (micActive) setStatus('Escuchando...', true);
  else if (ttsActive) setStatus('Hablando...', false);
  else setStatus('En línea', false);
}

function getVoices() {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve([]);
    let v = speechSynthesis.getVoices();
    if (v && v.length) return resolve(v);
    let done = false;
    const handler = () => {
      if (done) return;
      done = true;
      try { speechSynthesis.removeEventListener?.('voiceschanged', handler); } catch (_) {}
      resolve(speechSynthesis.getVoices() || []);
    };
    try { speechSynthesis.addEventListener?.('voiceschanged', handler); } catch (_) {}
    setTimeout(handler, 1500);
  });
}

async function pickVoice() {
  if (cachedVoice !== undefined) return cachedVoice;
  if (!('speechSynthesis' in window)) return (cachedVoice = null);
  const voices = await getVoices();
  if (!voices.length) return (cachedVoice = null);
  cachedVoice =
    voices.find((v) => v.lang.toLowerCase() === 'es-es') ||
    voices.find((v) => v.lang.toLowerCase().startsWith('es-es')) ||
    voices.find((v) => /^es[-_]/i.test(v.lang)) ||
    voices.find((v) => /es/i.test(v.lang)) ||
    voices.find((v) => v.default) ||
    voices[0] ||
    null;
  return cachedVoice;
}

function speakText(text) {
  if (!callMode || !('speechSynthesis' in window) || !text.trim()) return;
  if (cachedVoice === undefined) {
    pickVoice().then((v) => {
      cachedVoice = v;
      doSpeak(text, v);
    });
  } else {
    doSpeak(text, cachedVoice);
  }
}

function doSpeak(text, voice) {
  if (!callMode || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text.trim());
  if (voice) u.voice = voice;
  u.lang = 'es-ES';
  u.rate = 1.05;
  u.pitch = 1;
  u.volume = 1;
  u.onstart = () => setVoiceStatus();
  u.onend = () => setTimeout(setVoiceStatus, 50);
  u.onerror = () => setVoiceStatus();
  try { speechSynthesis.speak(u); } catch (_) {}
}

function processSpeechBuffer(force) {
  if (!callMode) return;
  const buf = speechBuffer;
  if (!buf || !buf.trim()) return;
  const re = /[^.!?…]+[.!?…]+(?:\s+|$)|[^.!?…]+$/g;
  const parts = buf.match(re);
  if (!parts) return;
  const last = parts[parts.length - 1];
  const lastComplete = /[.!?…]+\s*$/.test(last);
  if (!force && !lastComplete) return;
  let speakParts;
  if (force) {
    speakParts = parts.map((p) => p.trim()).filter(Boolean);
    speechBuffer = '';
  } else {
    speakParts = parts.slice(0, -1).map((p) => p.trim()).filter(Boolean);
    speechBuffer = last;
  }
  for (const p of speakParts) {
    const cleaned = stripMarkdown(p);
    if (cleaned) speakText(cleaned);
  }
}

function waitSpeechEndThenListen() {
  if (!callMode) return;
  const check = () => {
    if (!callMode) return;
    const ttsActive = ('speechSynthesis' in window) && speechSynthesis.speaking;
    if (ttsActive || sending) {
      setTimeout(check, 250);
      return;
    }
    if (!recognition) startVoice();
  };
  setTimeout(check, 200);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

ensureDayDivider();
const hello = buildRow({ role: 'them', text: '¡Hola! Soy magdielAI. Envíame texto o imágenes y te respondo. ✨ También puedes llamarme (📞) para hablar por voz.' });
updateSendButton();
input.focus();
