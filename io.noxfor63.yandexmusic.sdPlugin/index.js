'use strict';
const WebSocket = require('./vendor/ws');
const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');
const [, , , port, , uuid, , registration] = process.argv;
const dock = new WebSocket('ws://127.0.0.1:' + port);
const cards = new Set();
let worker;
let pending = false;
let previousImage;
function send(event, context, payload = {}) {
  if (dock.readyState === WebSocket.OPEN) dock.send(JSON.stringify({ event, context, payload }));
}
function request(action, context) {
  if (!worker || !worker.stdin.writable) {
    if (context) send('showAlert', context);
    return;
  }
  worker.stdin.write(JSON.stringify({ action, context }) + '\n');
}
function refresh() {
  if (cards.size && !pending && worker) {
    pending = true;
    request('track');
  }
}
function startWorker() {
  const executable = path.join(process.env.LOCALAPPDATA, 'Noxfor63', 'YandexMusicDock', 'venv', 'Scripts', 'python.exe');
  worker = spawn(executable, ['-u', path.join(__dirname, 'player.py')], {windowsHide: true, stdio: ['pipe','pipe','inherit']});
  worker.stdin.on('error', () => {});
  worker.on('error', err => console.error(err.message));
  worker.on('close', () => {
    worker = undefined;
    pending = false;
    previousImage = undefined;
    for (const context of cards) {
      send('setImage', context, {target: 0, image: ''});
      send('setTitle', context, {target: 0, title: 'Ошибка связи'});
    }
    if (dock.readyState === WebSocket.OPEN) setTimeout(startWorker, 5000).unref();
  });
  readline.createInterface({input: worker.stdout}).on('line', line => {
    const result = JSON.parse(line);
    if (result.action === 'track') {
      pending = false;
      const image = result.image || '';
      const title = result.error ? 'Ошибка связи' : image ? '' : 'Нет трека';
      const key = image || title;
      if (key !== previousImage) {
        for (const context of cards) {
          send('setImage', context, {target: 0, image});
          send('setTitle', context, {target: 0, title});
        }
        previousImage = key;
      }
    } else if (result.error) send('showAlert', result.context);
  });
}
dock.on('open', () => {
  dock.send(JSON.stringify({uuid, event: registration}));
  startWorker();
});
dock.on('message', raw => {
  const {event, action, context} = JSON.parse(raw);
  if (action === 'io.noxfor63.yandexmusic.track') {
    if (event === 'willAppear') {
      cards.add(context);
      previousImage = undefined;
      refresh();
    } else if (event === 'willDisappear') cards.delete(context);
  } else if (event === 'keyDown' && action?.startsWith('io.noxfor63.yandexmusic.')) {
    request(action.split('.').pop(), context);
  }
});
const timer = setInterval(refresh, 1500);
dock.on('error', err => console.error(err.message));
dock.on('close', () => { clearInterval(timer); worker?.kill(); });
