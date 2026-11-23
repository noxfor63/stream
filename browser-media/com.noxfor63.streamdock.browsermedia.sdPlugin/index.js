'use strict';

const WebSocket = require('./vendor/ws');
const {WebSocketServer} = WebSocket;
const {coordinate, layout} = require('./layout');
const manifest = require('./manifest.json');

const flags = process.argv.slice(2);
function argument(flag, fallbackIndex) {
  const index = flags.indexOf(flag);
  return flags[index < 0 ? fallbackIndex : index + 1];
}
const port = argument('-port', 1);
const uuid = argument('-pluginUUID', 3);
const registration = argument('-registerEvent', 5);
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !uuid || !registration) {
  console.error('Stream Dock launch arguments missing');
  process.exit(1);
}
let singleDevice = 'default';
try {
  const devices = JSON.parse(argument('-info', 7) || '{}').devices;
  if (Array.isArray(devices) && devices.length > 0) {
    singleDevice = devices.length === 1 ? (devices[0].id || 'default') : null;
  }
} catch { singleDevice = null; }

const extensionOrigin = 'chrome-extension://jfglpkafjfnniknfhmjnhamjnbgbijai';
const actions = new Map(manifest.Actions.map(({UUID}) => [UUID, UUID.split('.').pop()]));
const cards = new Map();
const pressed = new Set();
const painted = new Map();
const pending = new Map();
let nextId = 0;
let browser;
let bridge;
let retry;
let frame;
let stopped = false;
const dock = new WebSocket('ws://127.0.0.1:' + port);

function send(event, context, payload = {}) {
  if (dock.readyState === WebSocket.OPEN) dock.send(JSON.stringify({event, context, payload}));
}

let painting = false;
let redraw = false;

function paint() {
  if (dock.readyState !== WebSocket.OPEN) return;
  if (painting) {
    redraw = true;
    return;
  }
  // Queue at most one set of tiles to Stream Dock. While a slow device
  // drains it, later browser frames replace the pending frame in memory.
  const updates = [];
  for (const [context, tile] of layout(cards)) {
    const image = frame ? (tile === null ? frame.single : frame.tiles[tile]) : '';
    const title = frame ? '' : browser ? 'Ожидание' : 'Нет связи';
    const old = painted.get(context);
    if (!old || old.image !== image) updates.push({event:'setImage', context, payload:{target: 0, image}});
    if (!old || old.title !== title) updates.push({event:'setTitle', context, payload:{target: 0, title}});
    painted.set(context, {image, title});
  }
  if (!updates.length) return;
  painting = true;
  let remaining = updates.length;
  for (const update of updates) {
    dock.send(JSON.stringify(update), () => {
      if (--remaining) return;
      painting = false;
      if (redraw) {
        redraw = false;
        paint();
      }
    });
  }
}

function updateCard(context, device, payload) {
  const old = cards.get(context);
  const x = coordinate(payload?.coordinates?.column);
  const y = coordinate(payload?.coordinates?.row);
  const positioned = x !== undefined && y !== undefined;
  const setting = payload?.settings?.tile;
  const tile = setting !== undefined && /^[0-5]$/.test(String(setting)) ? Number(setting) : null;
  const card = {
    x: positioned ? x : old?.x,
    y: positioned ? y : old?.y,
    device: (typeof device === 'string' ? device : device?.id) || old?.device || singleDevice,
    tile: payload?.settings ? tile : old?.tile ?? null
  };
  if (old && card.x === old.x && card.y === old.y && card.tile === old.tile && card.device === old.device) return;
  cards.set(context, card);
  paint();
}

function finishCommand(id, ok) {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timeout);
  pending.delete(id);
  if (!ok && !stopped) send('showAlert', entry.context);
}

function command(action, context) {
  if (browser?.readyState !== WebSocket.OPEN) {
    send('showAlert', context);
    return;
  }
  const id = String(++nextId);
  pending.set(id, {context, timeout: setTimeout(() => finishCommand(id, false), 5000)});
  browser.send(JSON.stringify({type:'command', id, action}), err => {
    if (err) finishCommand(id, false);
  });
}

function isPng(value) {
  return typeof value === 'string' && value.startsWith('data:image/png;base64,iVBORw0KGgo');
}

function startBridge() {
  // Normal web pages cannot supply the extension origin. Restrict both the
  // local interface and handshake before accepting images or command results.
  bridge = new WebSocketServer({
    host: '127.0.0.1', port: 18765, path: '/browser-media', perMessageDeflate: false,
    maxPayload: 2 * 1024 * 1024,
    verifyClient: ({origin, req}) => origin === extensionOrigin &&
      req.headers.host === '127.0.0.1:18765' && req.url === '/browser-media'
  });
  bridge.on('error', error => {
    console.error('Browser connection unavailable:', error.code);
    if (error.code === 'EADDRINUSE' && !stopped) retry = setTimeout(startBridge, 5000);
  });
  bridge.on('connection', ws => {
    if (browser) {
      ws.close(1013, 'Another browser is connected');
      return;
    }
    browser = ws;
    paint();
    ws.on('error', () => ws.terminate());
    ws.on('message', (raw, binary) => {
      let message;
      try {
        if (binary) throw Error();
        message = JSON.parse(raw.toString());
      } catch {
        ws.close(1003, 'Expected JSON');
        return;
      }
      if (message?.type === 'frame' && isPng(message.single) &&
          Array.isArray(message.tiles) && message.tiles.length === 6 && message.tiles.every(isPng)) {
        frame = {single:message.single, tiles:message.tiles};
        paint();
      } else if (message?.type === 'result' && typeof message.ok === 'boolean') {
        finishCommand(message.id, message.ok);
      } else if (message?.type === 'ping') {
        ws.send('{"type":"pong"}');
      }
    });
    ws.once('close', () => {
      browser = undefined;
      frame = undefined;
      for (const id of pending.keys()) finishCommand(id, false);
      paint();
    });
  });
}

dock.on('open', () => {
  dock.send(JSON.stringify({event: registration, uuid}));
  startBridge();
});
dock.on('error', error => console.error('Stream Dock connection:', error.code));
dock.on('message', raw => {
  let message;
  try { message = JSON.parse(raw.toString()); } catch { return; }
  const {event, action, context, device, payload} = message || {};
  const name = actions.get(action);
  if (!name) return;
  if (event === 'willDisappear') {
    pressed.delete(context);
    if (cards.delete(context)) {
      painted.delete(context);
      paint();
    }
    return;
  }
  if (name === 'player') {
    if (event === 'willAppear' || (cards.has(context) && event === 'didReceiveSettings')) {
      updateCard(context, device, payload);
      if (event === 'willAppear' && !payload?.settings) send('getSettings', context);
    } else if (event === 'sendToPlugin' && cards.has(payload?.keyContext) && typeof payload.tile === 'string') {
      updateCard(payload.keyContext, null, {settings: {tile:payload.tile}});
    } else if (cards.has(context) && payload?.coordinates) {
      updateCard(context, device, {coordinates:payload.coordinates});
    }
    return;
  }
  if (event === 'keyDown') {
    pressed.add(context);
    command(name, context);
  } else if (event === 'keyUp' && !pressed.delete(context)) {
    command(name, context);
  }
});
dock.once('close', () => {
  stopped = true;
  clearTimeout(retry);
  for (const id of pending.keys()) finishCommand(id, false);
  browser?.terminate();
  bridge?.close();
});
