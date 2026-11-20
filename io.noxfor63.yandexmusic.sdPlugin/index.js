'use strict';
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');
const WebSocket = require('./vendor/ws');
const manifest = require('./manifest.json');

const appDir = path.join(process.env.LOCALAPPDATA, 'Noxfor63', 'YandexMusicDock');
const logFile = path.join(appDir, 'dock.log');
// Record only controlled event names and error codes. Never log event payloads.
function trace(message) {
  try {
    fs.mkdirSync(appDir, {recursive: true});
    const previous = fs.statSync(logFile, {throwIfNoEntry: false});
    const flag = previous && previous.size >= 64 * 1024 ? 'w' : 'a';
    fs.writeFileSync(logFile, new Date().toISOString() + ' ' + message + '\n', {flag});
  } catch {
    // A log write failure must not interrupt the controls.
  }
}
function errorCode(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_]{1,40}$/.test(value) ? value : 'unknown';
}

const args = process.argv.slice(2);
function argument(name, position) {
  const index = args.indexOf(name);
  return args[index === -1 ? position : index + 1];
}
const port = argument('-port', 1);
const uuid = argument('-pluginUUID', 3);
const registration = argument('-registerEvent', 5);
// Some hosts omit device in individual key events on a single-panel profile.
let singleDevice = 'default';
try {
  const devices = JSON.parse(argument('-info', 7) || '{}').devices;
  if (Array.isArray(devices) && devices.length) singleDevice = devices.length === 1 ? (devices[0].id || 'default') : null;
} catch {
  singleDevice = null;
}
trace('host startup');
if (!/^\d{1,5}$/.test(port) || Number(port) > 65535 || !uuid || !registration) {
  trace('host invalid launch arguments');
  process.exit(1);
}
const dock = new WebSocket('ws://127.0.0.1:' + port);
const actions = new Map(manifest.Actions.map(({UUID}) => [UUID, UUID.split('.').pop()]));
const supportedActions = new Set(actions.values());
const cards = new Map();
const displayed = new Map();
const volumeTimers = new Map();
let layoutVersion = 0;
const pressedContexts = new Set();
const waiting = [];
let watchdog;
let worker;
let retry;
let pending = false;
let stopping = false;
let lastTrackStatus;

function send(event, context, payload = {}) {
  if (dock.readyState === WebSocket.OPEN) dock.send(JSON.stringify({event, context, payload}));
}
function watchForReply() {
  clearTimeout(watchdog);
  if (!waiting.length) return;
  watchdog = setTimeout(() => {
    trace('player response timeout');
    worker?.kill();
  }, 15000);
}
function request(action, context, fields = {}) {
  if (!worker?.stdin.writable) {
    if (context) send('showAlert', context);
    return false;
  }
  waiting.push(context);
  if (waiting.length === 1) watchForReply();
  worker.stdin.write(JSON.stringify({action, context, ...fields}) + '\n');
  return true;
}
function axis(value) {
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function updateCard(context, payload, device) {
  const previous = cards.get(context);
  const coords = payload?.coordinates;
  const column = axis(coords?.column);
  const row = axis(coords?.row);
  const positioned = column !== undefined && row !== undefined;
  const settings = payload?.settings;
  const requested = settings?.coverCorner;
  const corner = ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(requested)
    ? requested : 'auto';
  const card = {
    context,
    device: (typeof device === 'string' ? device : device?.id) || previous?.device || singleDevice,
    column: positioned ? column : previous?.column,
    row: positioned ? row : previous?.row,
    coverCorner: settings ? corner : previous?.coverCorner || 'auto'
  };
  if (previous && card.device === previous.device && card.column === previous.column &&
      card.row === previous.row && card.coverCorner === previous.coverCorner) return;
  cards.set(context, card);
  trace('cover ' + card.coverCorner + ' ' + (card.column === undefined ? 'no coordinates' : card.column + ',' + card.row));
  displayed.delete(context);
  layoutVersion++;
  refresh();
}

function refresh() {
  if (cards.size && !pending) {
    pending = request('track', undefined, {layoutVersion, cards: [...cards.values()]});
  }
}
function display(tiles, title) {
  for (const context of cards.keys()) {
    const image = tiles?.[context] || '';
    const key = image || title;
    if (displayed.get(context) === key) continue;
    displayed.set(context, key);
    send('setImage', context, {target: 0, image});
    send('setTitle', context, {target: 0, title});
  }
}
function volumeFeedback(context, title) {
  clearTimeout(volumeTimers.get(context));
  send('setTitle', context, {target: 0, title});
  volumeTimers.set(context, setTimeout(() => {
    send('setTitle', context, {target: 0, title: ''});
    volumeTimers.delete(context);
  }, 1800));
}
function startWorker() {
  const executable = path.join(appDir, 'venv', 'Scripts', 'python.exe');
  worker = spawn(executable, ['-X', 'utf8', '-u', path.join(__dirname, 'player.py')], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'inherit']
  });
  worker.once('spawn', () => trace('player process started'));
  worker.stdin.on('error', err => trace('player stdin error ' + errorCode(err.code)));
  worker.on('error', err => trace('player launch error ' + errorCode(err.code)));
  worker.on('close', code => {
    clearTimeout(watchdog);
    for (const context of waiting.splice(0)) {
      if (context && !stopping) send('showAlert', context);
    }
    worker = undefined;
    pending = false;
    lastTrackStatus = undefined;
    if (stopping) return;
    trace('player stopped ' + (Number.isInteger(code) ? code : 'signal'));
    display('', 'Сбой плагина');
    retry = setTimeout(startWorker, 5000);
  });
  readline.createInterface({input: worker.stdout}).on('line', line => {
    let result;
    try {
      result = JSON.parse(line);
    } catch {
      trace('player invalid response');
      worker.kill();
      return;
    }
    waiting.shift();
    watchForReply();
    if (result.action === 'track') {
      pending = false;
      if (result.layoutVersion !== layoutVersion) {
        refresh();
        return;
      }
      const hasTrack = result.tiles && Object.keys(result.tiles).length > 0;
      const status = result.error ? 'error ' + errorCode(result.error) : hasTrack ? 'available' : 'no track';
      if (status !== lastTrackStatus) trace('player track ' + status);
      lastTrackStatus = status;
      display(result.tiles, result.error ? 'Сбой плагина' : hasTrack ? '' : 'Нет трека');
    } else if (supportedActions.has(result.action)) {
      trace('player ' + result.action + (result.error ? ' error ' + errorCode(result.error) : ' ok'));
      if (['louder', 'quieter'].includes(result.action) && Number.isInteger(result.level)) {
        trace('volume ' + errorCode(result.source) + ' ' + result.level + '%');
        volumeFeedback(result.context, result.level + '%');
      } else if (result.error === 'NoAppVolumeSlider') {
        volumeFeedback(result.context, 'Открой ЯМ');
      }
      if (result.error) send('showAlert', result.context);
    }
  });
}
dock.on('open', () => {
  dock.send(JSON.stringify({uuid, event: registration}));
  trace('host registration sent');
  startWorker();
});
dock.on('message', raw => {
  const {event, action, context, payload, device} = JSON.parse(raw);
  const name = actions.get(action);
  if (!name) return;
  if (event === 'willAppear' || event === 'willDisappear' || event === 'keyDown' || event === 'keyUp') {
    trace('host ' + event + ' ' + name);
  }
  if (name === 'track') {
    if (event === 'willAppear' || (cards.has(context) && event === 'didReceiveSettings')) {
      updateCard(context, payload, device);
      if (event === 'willAppear' && !payload?.settings) send('getSettings', context);
    } else if (event === 'sendToPlugin' && cards.has(payload?.trackContext) && typeof payload.coverCorner === 'string') {
      updateCard(payload.trackContext, {settings: {coverCorner: payload.coverCorner}});
    } else if (cards.has(context) && payload?.coordinates && ['keyDown', 'keyUp', 'titleParametersDidChange'].includes(event)) {
      updateCard(context, {coordinates: payload.coordinates}, device);
    } else if (event === 'willDisappear') {
      cards.delete(context);
      displayed.delete(context);
      layoutVersion++;
      refresh();
    }
  } else if (event === 'keyDown') {
    pressedContexts.add(context);
    request(name, context);
  } else if (event === 'keyUp') {
    if (!pressedContexts.delete(context)) request(name, context);
  } else if (event === 'willDisappear') {
    pressedContexts.delete(context);
    clearTimeout(volumeTimers.get(context));
    volumeTimers.delete(context);
  }
});
const timer = setInterval(refresh, 1500);
dock.on('error', err => trace('host socket error ' + errorCode(err.code)));
dock.on('close', () => {
  stopping = true;
  trace('host disconnected');
  clearTimeout(retry);
  clearInterval(timer);
  for (const timer of volumeTimers.values()) clearTimeout(timer);
  worker?.kill();
});
