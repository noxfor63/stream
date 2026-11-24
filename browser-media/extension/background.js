'use strict';
importScripts('render.js');

const endpoint = 'ws://127.0.0.1:18765/browser-media';
const sources = new Map();
const pending = new Map();
let nextId = 0;
let selectedKey;
let socket;
let reconnectTimer;
let renderTimer;
let heartbeat;
let rendering = false;
let renderAgain = false;
let lastSent;
let lastRenderStart = 0;
let artwork;
let artworkKey;
let commandQueue = Promise.resolve();
const frameRates = new Set([15, 20, 30]);
let targetFps = 30;
const settingsReady = chrome.storage.local.get('fps').then(settings => {
  if (frameRates.has(settings.fps)) targetFps = settings.fps;
}).catch(error => console.warn('Frame rate settings unavailable', error.name));

function selected() {
  if (!sources.has(selectedKey)) {
    const ordered = [...sources.values()].sort((a, b) =>
      Number(b.state.audible) - Number(a.state.audible) ||
      Number(!b.state.paused) - Number(!a.state.paused) ||
      b.state.started - a.state.started
    );
    selectedKey = ordered[0]?.key;
  }
  return sources.get(selectedKey);
}

function chooseNext() {
  const keys = [...sources.keys()];
  if (!keys.length) return false;
  const index = keys.indexOf(selected()?.key);
  selectedKey = keys[(index + 1) % keys.length];
  return true;
}

function request(source, type, extra = {}) {
  const id = String(++nextId);
  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      resolve({ok: false});
    }, type === 'art' ? 4500 : 2500);
    pending.set(id, {port: source.port, timeout, resolve});
    try {
      source.port.postMessage({type, id, player: source.state.id, ...extra});
    } catch {
      settle(id, {ok: false});
    }
  });
}

function settle(id, result) {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timeout);
  pending.delete(id);
  entry.resolve(result);
}

function cleanState(input) {
  if (!input || typeof input.id !== 'string') return null;
  const text = value => typeof value === 'string' ? value.slice(0, 240) : '';
  return {
    id: input.id.slice(0, 100),
    title: text(input.title),
    artist: text(input.artist),
    source: text(input.source),
    paused: Boolean(input.paused),
    audible: Boolean(input.audible),
    started: Number.isFinite(input.started) ? input.started : 0,
    position: Number.isFinite(input.position) ? Math.max(0, input.position) : 0,
    duration: Number.isFinite(input.duration) ? Math.max(0, input.duration) : null,
    live: Boolean(input.live),
    video: Boolean(input.video),
    protected: Boolean(input.protected),
    artwork: Number.isSafeInteger(input.artwork) ? input.artwork : 0
  };
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'browser-media-player' || port.sender?.id !== chrome.runtime.id ||
      !Number.isInteger(port.sender?.tab?.id)) return;
  const prefix = port.sender.tab.id + ':' + port.sender.frameId + ':' + (port.sender.documentId || '');
  port.onMessage.addListener(message => {
    if (message?.type === 'sources' && Array.isArray(message.state)) {
      const keep = new Set();
      for (const input of message.state.slice(0, 50)) {
        const state = cleanState(input);
        if (!state) continue;
        const key = prefix + ':' + state.id;
        keep.add(key);
        sources.set(key, {key, state, port});
      }
      for (const [key, item] of sources) {
        if (item.port === port && !keep.has(key)) sources.delete(key);
      }
      scheduleRender(0);
      connect();
    } else if (typeof message?.id === 'string' && pending.get(message.id)?.port === port) {
      settle(message.id, message);
    }
  });
  port.onDisconnect.addListener(() => {
    for (const [key, item] of sources) {
      if (item.port === port) sources.delete(key);
    }
    for (const [id, entry] of pending) {
      if (entry.port === port) settle(id, {ok: false});
    }
    scheduleRender(0);
  });
});

async function bitmap(uri) {
  if (typeof uri !== 'string' || uri.length > 700_000 || !uri.startsWith('data:image/jpeg;base64,')) return null;
  const response = await fetch(uri);
  return createImageBitmap(await response.blob());
}

function scheduleRender(delay = 0) {
  clearTimeout(renderTimer);
  if (socket?.readyState !== WebSocket.OPEN) return;
  if (rendering) {
    renderAgain = true;
    return;
  }
  // Budget from the beginning of the previous frame. Waiting a whole interval
  // after PNG encoding reduced even the old 6 fps limit to about 5 fps.
  renderTimer = setTimeout(render, Math.ceil(Math.max(delay,
    lastRenderStart + 1000 / targetFps - performance.now())));
}

async function render() {
  if (socket?.readyState !== WebSocket.OPEN) return;
  // Keep the newest frame in the worker; an unplugged or slow dock must not
  // accumulate old video frames in the WebSocket write queue.
  if (socket.bufferedAmount > 256 * 1024) {
    scheduleRender(200);
    return;
  }
  rendering = true;
  lastRenderStart = performance.now();
  renderAgain = false;
  const source = selected();
  const key = source?.key;
  let video;
  let state = source?.state || null;
  try {
    if (state?.video && !state.protected) {
      const captured = await request(source, 'frame');
      if (captured.ok) video = await bitmap(captured.data);
      if (!video && ['restricted', 'protected'].includes(captured.reason)) state = {...state, videoUnavailable: true};
    } else if (state?.protected) {
      state = {...state, videoUnavailable: true};
    }
    const artId = state?.artwork ? key + '/' + state.artwork : undefined;
    if (!video && artworkKey !== artId) {
      artwork?.close();
      artwork = undefined;
      artworkKey = artId;
      if (artId) {
        const response = await request(source, 'art', {version: state.artwork});
        if (response.ok) artwork = await bitmap(response.data);
      }
    }
    const output = await renderPlayer(state, artwork, video);
    if (key !== selected()?.key) {
      renderAgain = true;
      return;
    }
    const data = JSON.stringify({type: 'frame', ...output});
    if (data !== lastSent && socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 256 * 1024) {
      socket.send(data);
      lastSent = data;
    }
  } catch (error) {
    console.warn('Player rendering failed', error.name);
  } finally {
    video?.close();
    rendering = false;
    const fastVideo = Boolean(video) && selected()?.state.video && !selected()?.state.paused;
    scheduleRender(renderAgain || fastVideo ? 0 : 1000);
  }
}

async function command(message, peer) {
  let ok = false;
  const source = selected();
  if (message.action === 'cycle') ok = chooseNext();
  else if (source && ['toggle', 'back', 'forward', 'quieter', 'louder', 'mute'].includes(message.action)) {
    const result = await request(source, 'control', {action: message.action});
    ok = result.ok === true;
  }
  if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({type: 'result', id: message.id, ok}));
  scheduleRender(0);
}

function connect() {
  if (socket && socket.readyState < WebSocket.CLOSING) return;
  clearTimeout(reconnectTimer);
  const peer = new WebSocket(endpoint);
  socket = peer;
  peer.onopen = () => {
    lastSent = undefined;
    scheduleRender(0);
    // Chromium 116+ keeps a worker alive when WS traffic occurs within 30 s.
    heartbeat = setInterval(() => {
      if (peer.readyState === WebSocket.OPEN) peer.send('{"type":"ping"}');
    }, 20000);
  };
  peer.onmessage = event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message?.type !== 'command' || typeof message.id !== 'string') return;
    commandQueue = commandQueue.then(() => command(message, peer)).catch(error => {
      console.warn('Player command failed', error.name);
      if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({type:'result', id:message.id, ok:false}));
    });
  };
  peer.onerror = () => peer.close();
  peer.onclose = () => {
    clearInterval(heartbeat);
    clearTimeout(renderTimer);
    if (socket === peer) socket = undefined;
    reconnectTimer = setTimeout(connect, 3000);
  };
}

// Alarms wake a suspended worker when Stream Dock starts later than the browser.
chrome.alarms.create('reconnect-browser-media', {periodInMinutes: 1});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'reconnect-browser-media') connect();
});
chrome.runtime.onStartup.addListener(connect);
connect();

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab) return;
  if (!['status', 'select', 'fps'].includes(message?.type)) return;
  settingsReady.then(async () => {
    if (message.type === 'select' && typeof message.key === 'string' && sources.has(message.key)) {
      selectedKey = message.key;
      scheduleRender(0);
    }
    if (message.type === 'fps' && frameRates.has(message.fps)) {
      await chrome.storage.local.set({fps: message.fps});
      targetFps = message.fps;
      scheduleRender(0);
    }
    respond({
      connected: socket?.readyState === WebSocket.OPEN,
      fps: targetFps,
      selected: selected()?.key,
      players: [...sources.values()].map(item => ({key:item.key, title:item.state.title, source:item.state.source}))
    });
  }).catch(() => respond({error: true}));
  return true;
});
