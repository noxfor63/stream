(() => {
  const ids = new WeakMap();
  const started = new WeakMap();
  let elements = new Map();
  let nextId = 0;
  let port;
  let lastState = '';
  let updateTimer;
  let active = true;

  function reportSoon() {
    if (!active || updateTimer !== undefined) return;
    updateTimer = setTimeout(report, 60);
  }
  function candidates() {
    return [...document.querySelectorAll('audio,video')].filter(el =>
      el.isConnected && (el.currentSrc || el.srcObject || el.readyState > 0)
    );
  }
  function titleText(value) {
    return (value || '').trim().slice(0, 240);
  }
  function artworkUrl(el, metadata, primary) {
    const sizes = (metadata?.artwork || []).map(item => ({
      src: item.src,
      width: parseInt(item.sizes, 10) || 0
    }));
    // Prefer the smallest available image wide enough for a 3 × 2 display.
    sizes.sort((a, b) => (a.width >= 432 && b.width >= 432) ? a.width - b.width : b.width - a.width);
    const raw = sizes[0]?.src || el.poster ||
      (primary && document.querySelector('meta[property="og:image"]')?.content);
    if (!raw) return '';
    try {
      const url = new URL(raw, document.baseURI);
      if (/^https?:$/.test(url.protocol) || url.protocol === 'blob:' ||
          (url.protocol === 'data:' && raw.startsWith('data:image/') && raw.length <= 512_000)) return url.href;
    } catch {}
    return '';
  }

  const protectedMedia = new WeakSet();
  const blockedVideo = new WeakMap();
  const canvases = new WeakMap();
  function videoFrame(el) {
    if (!(el instanceof HTMLVideoElement) || el.mediaKeys || protectedMedia.has(el)) return {reason:'protected'};
    if (!el.videoWidth || !el.videoHeight || el.readyState < 2) return {reason:'loading'};
    if (blockedVideo.get(el) === el.currentSrc) return {reason:'restricted'};
    const scale = Math.min(432 / el.videoWidth, 288 / el.videoHeight, 1);
    const width = Math.max(1, Math.round(el.videoWidth * scale));
    const height = Math.max(1, Math.round(el.videoHeight * scale));
    const canvas = canvases.get(el) || document.createElement('canvas');
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    try {
      canvas.getContext('2d', {alpha:false}).drawImage(el, 0, 0, width, height);
      const data = canvas.toDataURL('image/jpeg', 0.77);
      canvases.set(el, canvas);
      return {data};
    } catch (err) {
      if (err.name === 'SecurityError') {
        blockedVideo.set(el, el.currentSrc);
        canvases.delete(el);
        return {reason:'restricted'};
      }
      return {reason:'loading'};
    }
  }

  let artVersion = 0;
  const artSources = new WeakMap();
  function describe(el, primary) {
    const metadata = primary ? navigator.mediaSession?.metadata : null;
    const url = artworkUrl(el, metadata, primary);
    if (artSources.get(el)?.url !== url) artSources.set(el, {url, version: ++artVersion});
    const playing = !el.paused && !el.ended;
    const source = titleText(document.querySelector('meta[property="og:site_name"]')?.content) ||
      location.hostname || 'Браузер';
    return {
      id: ids.get(el),
      title: titleText(metadata?.title || el.getAttribute('aria-label') || el.title || document.title) || 'Мультимедиа',
      artist: titleText(metadata?.artist),
      source,
      paused: !playing,
      audible: playing && el.volume > 0 && !el.muted,
      started: started.get(el) || 0,
      position: Math.max(0, Math.floor(el.currentTime || 0)),
      duration: Number.isFinite(el.duration) ? Math.max(0, el.duration) : null,
      live: el.duration === Infinity || (el.srcObject != null && !Number.isFinite(el.duration)),
      video: el instanceof HTMLVideoElement,
      protected: Boolean(el.mediaKeys || protectedMedia.has(el)),
      artwork: url ? artSources.get(el).version : 0
    };
  }
  function report() {
    updateTimer = undefined;
    if (!active) return;
    const media = candidates();
    elements = new Map();
    for (const el of media) {
      if (!ids.has(el)) ids.set(el, String(++nextId));
      elements.set(ids.get(el), el);
    }
    if (!media.length) {
      if (port) port.disconnect();
      port = undefined;
      return;
    }
    if (!port) {
      try {
        const channel = chrome.runtime.connect({name: 'browser-media-player'});
        port = channel;
        lastState = '';
        channel.onMessage.addListener(message => onRequest(channel, message));
        channel.onDisconnect.addListener(() => {
          void chrome.runtime.lastError;
          if (port === channel) port = undefined;
        });
      } catch {
        // Reloading an extension invalidates scripts in tabs opened earlier.
        stop();
        return;
      }
    }
    const primary = [...media].sort((a, b) =>
      Number(b.paused === false) - Number(a.paused === false) || (started.get(b) || 0) - (started.get(a) || 0)
    )[0];
    const state = media.map(el => describe(el, el === primary));
    const encoded = JSON.stringify(state);
    if (encoded === lastState) return;
    lastState = encoded;
    try { port.postMessage({type: 'sources', state}); } catch { port = undefined; }
  }

  async function adjust(el, action) {
    switch (action) {
      case 'toggle':
        if (!el.paused && !el.ended) el.pause();
        else await el.play();
        return true;
      case 'back':
      case 'forward': {
        const pos = el.currentTime;
        // Clamp to the current seekable window, including a live DVR timeline.
        const ranges = el.seekable;
        if (!ranges.length) return false;
        let i = ranges.length - 1;
        while (i > 0 && ranges.start(i) > pos) i--;
        el.currentTime = Math.max(ranges.start(i), Math.min(ranges.end(i), pos + (action === 'back' ? -10 : 10)));
        return true;
      }
      case 'mute':
        el.muted = !el.muted;
        return true;
      case 'louder':
      case 'quieter': {
        const level = Math.min(1, Math.max(0, Math.round(el.volume * 100 + (action === 'louder' ? 5 : -5)) / 100));
        if (action === 'louder' && el.muted) el.muted = false;
        el.volume = level;
        return Math.abs(el.volume - level) < 0.01;
      }
      default:
        return false;
    }
  }

  async function thumbnail(url) {
    if (!url) return null;
    // Page-origin/CORS rules apply. Only artwork is requested, with no cookies.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    let bitmap;
    try {
      const response = await fetch(url, {
        credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal
      });
      if (!response.ok || !response.body) return null;
      const reader = response.body.getReader();
      const chunks = [];
      let length = 0;
      while (true) {
        const {value, done} = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 4 * 1024 * 1024) {
          controller.abort();
          return null;
        }
        chunks.push(value);
      }
      bitmap = await createImageBitmap(new Blob(chunks, {type: response.headers.get('content-type') || ''}));
      const scale = Math.min(1, 432 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(scale * bitmap.width));
      canvas.height = Math.max(1, Math.round(scale * bitmap.height));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.82);
    } finally {
      clearTimeout(timer);
      bitmap?.close();
    }
  }

  async function onRequest(channel, msg) {
    const el = elements.get(msg.player);
    const reply = {type: msg.type, id: msg.id, ok: false};
    try {
      if (el?.isConnected) {
        if (msg.type === 'frame') {
          Object.assign(reply, videoFrame(el));
          reply.ok = Boolean(reply.data);
        } else if (msg.type === 'art') {
          const art = artSources.get(el);
          if (art && art.version === msg.version) reply.data = await thumbnail(art.url);
          reply.ok = Boolean(reply.data);
        } else if (msg.type === 'control') reply.ok = await adjust(el, msg.action);
      }
    } catch {}
    try { channel.postMessage(reply); } catch {}
    if (msg.type === 'control') reportSoon();
  }

  const events = ['playing','pause','ended','loadedmetadata','emptied','seeked','volumechange','encrypted'];
  function eventUpdate(event) {
    const media = event.target;
    if (!(media instanceof HTMLMediaElement)) return;
    if (event.type === 'encrypted') protectedMedia.add(media);
    if (event.type === 'emptied') {
      protectedMedia.delete(media);
      blockedVideo.delete(media);
    }
    if (event.type === 'playing') started.set(media, Date.now());
    reportSoon();
  }
  for (const name of events) document.addEventListener(name, eventUpdate, true);
  const interval = setInterval(reportSoon, 1000);
  function stop() {
    active = false;
    clearTimeout(updateTimer);
    clearInterval(interval);
    for (const name of events) document.removeEventListener(name, eventUpdate, true);
    port?.disconnect();
  }
  window.addEventListener('pagehide', () => {
    if (port) { port.disconnect(); port = undefined; }
    active = false;
  });
  window.addEventListener('pageshow', () => { active = true; reportSoon(); });
  reportSoon();
})();
