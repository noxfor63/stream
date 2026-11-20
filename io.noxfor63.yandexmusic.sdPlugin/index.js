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
trace('host startup');
if (!/^\d{1,5}$/.test(port) || Number(port) > 65535 || !uuid || !registration) {
  trace('host invalid launch arguments');
  process.exit(1);
}
const dock = new WebSocket('ws://127.0.0.1:' + port);
const actions = new Map(manifest.Actions.map(({UUID}) => [UUID, UUID.split('.').pop()]));
const supportedActions = new Set(actions.values());
const cards = new Set();
const pressedContexts = new Set();
const waiting = [];
let watchdog;
let worker;
let retry;
let pending = false;
let stopping = false;
let previousImage;
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
function request(action, context) {
  if (!worker?.stdin.writable) {
    if (context) send('showAlert', context);
    return false;
  }
  waiting.push(context);
  if (waiting.length === 1) watchForReply();
  worker.stdin.write(JSON.stringify({action, context}) + '\n');
  return true;
}
function refresh() {
  if (cards.size && !pending) pending = request('track');
}
function display(image, title) {
  const key = image || title;
  if (key === previousImage) return;
  for (const context of cards) {
    send('setImage', context, {target: 0, image});
    send('setTitle', context, {target: 0, title});
  }
  previousImage = key;
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
      const image = result.image || '';
      const status = result.error ? 'error ' + errorCode(result.error) : image ? 'available' : 'no track';
      if (status !== lastTrackStatus) trace('player track ' + status);
      lastTrackStatus = status;
      display(image, result.error ? 'Сбой плагина' : image ? '' : 'Нет трека');
    } else if (supportedActions.has(result.action)) {
      trace('player ' + result.action + (result.error ? ' error ' + errorCode(result.error) : ' ok'));
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
  const {event, action, context} = JSON.parse(raw);
  const name = actions.get(action);
  if (!name) return;
  if (event === 'willAppear' || event === 'willDisappear' || event === 'keyDown' || event === 'keyUp') {
    trace('host ' + event + ' ' + name);
  }
  if (name === 'track') {
    if (event === 'willAppear') {
      cards.add(context);
      previousImage = undefined;
      send('setTitle', context, {target: 0, title: worker ? 'Загрузка…' : 'Сбой плагина'});
      refresh();
    } else if (event === 'willDisappear') cards.delete(context);
  } else if (event === 'keyDown') {
    pressedContexts.add(context);
    request(name, context);
  } else if (event === 'keyUp') {
    if (!pressedContexts.delete(context)) request(name, context);
  } else if (event === 'willDisappear') {
    pressedContexts.delete(context);
  }
});
const timer = setInterval(refresh, 1500);
dock.on('error', err => trace('host socket error ' + errorCode(err.code)));
dock.on('close', () => {
  stopping = true;
  trace('host disconnected');
  clearTimeout(retry);
  clearInterval(timer);
  worker?.kill();
});
