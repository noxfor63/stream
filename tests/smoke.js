// Linux integration test with a simulated Windows worker and Stream Dock host.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const root = path.resolve(__dirname, '../io.noxfor63.yandexmusic.sdPlugin');
const {WebSocketServer} = require(path.join(root, 'vendor/ws'));
const manifest = require(path.join(root, 'manifest.json'));

async function exercise(mode) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-test-'));
  const appDir = path.join(tmp, 'Noxfor63/YandexMusicDock');
  const executable = path.join(appDir, 'venv/Scripts/python.exe');
  const commands = path.join(tmp, 'commands');
  if (mode !== 'missing') {
    fs.mkdirSync(path.dirname(executable), {recursive: true});
    fs.writeFileSync(executable, `#!/usr/bin/env node
require('readline').createInterface({input:process.stdin}).on('line', line => {
  const msg = JSON.parse(line);
  require('fs').appendFileSync(process.env.TEST_LOG, msg.action+'\\n');
  if (process.env.TEST_MODE === 'hung') return;
  const tiles = msg.cards && Object.fromEntries(msg.cards.map(c => [c.context, process.env.TEST_MODE === 'layout' ? [msg.cards.length, c.device, c.column, c.row].join('/') : 'sample-card']));
  console.log(JSON.stringify({...msg, tiles, level:msg.action==='quieter'?45:undefined, source:'app', error:msg.action==='previous'?'OSError':undefined}));
});`, {mode:0o755});
  }
  const server = new WebSocketServer({host:'127.0.0.1', port:0});
  await once(server, 'listening');
  // Vary flag order; the SDK fields must be taken from their named argument.
  const child = spawn(process.execPath, [path.join(root, manifest.CodePathWin),
    '-pluginUUID', 'private-uuid', '-registerEvent', 'registerPlugin',
    '-port', server.address().port, '-info', '{}'], {
    env: {...process.env, LOCALAPPDATA:tmp, TEST_LOG:commands, TEST_MODE:mode}
  });
  let timer;
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(Error('No response from plugin')), mode === 'hung' ? 21000 : 6000);
      }),
      verifyEvents(server, child, mode)
    ]);
    const trace = fs.readFileSync(path.join(appDir, 'dock.log'), 'utf8');
    for (const marker of ['host startup', 'host registration sent', 'host willAppear track', 'host disconnected']) {
      assert.ok(trace.includes(marker), marker);
    }
    assert.doesNotMatch(trace, /private-uuid|private-context|sample-card/);
    if (mode === 'ok') {
      assert.ok(trace.includes('player track available'));
      assert.ok(trace.includes('volume app 45%'));
      assert.ok(trace.includes('player previous error OSError'));
      assert.deepEqual(fs.readFileSync(commands, 'utf8').trim().split('\n').sort(),
        ['louder','next','next','previous','quieter','toggle','track']);
    } else if (mode === 'layout') {
      assert.ok(trace.includes('host willDisappear track'));
    } else if (mode === 'hung') {
      assert.ok(trace.includes('player response timeout'));
    } else {
      assert.ok(trace.includes('player launch error ENOENT'));
    }
  } finally {
    clearTimeout(timer);
    child.kill();
    for (const socket of server.clients) socket.terminate();
    server.close();
    fs.rmSync(tmp, {recursive:true, force:true});
  }
}

async function verifyEvents(server, child, mode) {
  const exit = once(child, 'exit');
  const [socket] = await once(server, 'connection');
  let imageReceived = false;
  let alertReceived = false;
  let volumeConfirmed = false;
  const layoutKeys = new Set();
  let shrunk = false;
  socket.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.event === 'registerPlugin') {
      assert.equal(msg.uuid, 'private-uuid');
      assert.equal(manifest.Actions.length, 6);
      if (mode === 'layout') {
        for (const [id, x, y] of [['a',0,0],['b',1,0],['c',0,1],['d',1,1]]) {
          socket.send(JSON.stringify({event:'willAppear', action:manifest.Actions[0].UUID, context:id,
            device:'panel', payload:{coordinates:{column:String(x), row:String(y)}}}));
        }
        return;
      }
      for (const {UUID:action, Icon} of manifest.Actions) {
        assert.ok(fs.existsSync(path.join(root, Icon)));
        const name = action.split('.').pop();
        const context = 'private-context-' + name;
        socket.send(JSON.stringify({action, context, event:'willAppear'}));
        if (mode === 'ok' && name !== 'track') {
          if (name !== 'louder') socket.send(JSON.stringify({action, context, event:'keyDown'}));
          if (name === 'next') socket.send(JSON.stringify({action, context, event:'keyDown'}));
          socket.send(JSON.stringify({action, context, event:'keyUp'}));
        }
      }
    } else if (msg.event === 'setImage' && mode === 'layout') {
      const coords = {a:'0/0', b:'1/0', c:'0/1', d:'1/1'};
      assert.equal(msg.payload.image, (shrunk ? '2' : '4') + '/panel/' + coords[msg.context]);
      layoutKeys.add(msg.context);
      if (!shrunk && layoutKeys.size === 4) {
        shrunk = true;
        layoutKeys.clear();
        for (const context of ['c','d']) {
          socket.send(JSON.stringify({event:'willDisappear', action:manifest.Actions[0].UUID, context}));
        }
      } else if (shrunk && layoutKeys.size === 2) {
        assert.deepEqual([...layoutKeys].sort(), ['a','b']);
        socket.close();
      }
    } else if (msg.event === 'setImage' && mode === 'ok') {
      assert.equal(msg.payload.image, 'sample-card');
      assert.equal(msg.context, 'private-context-track');
      imageReceived = true;
    } else if (msg.event === 'showAlert' && mode === 'ok') {
      assert.equal(msg.context, 'private-context-previous');
      alertReceived = true;
    } else if (mode !== 'ok' && msg.event === 'setTitle' && msg.payload.title === 'Сбой плагина') {
      socket.close();
    }
    if (msg.event === 'setTitle' && msg.context === 'private-context-quieter' && msg.payload.title === '45%') volumeConfirmed = true;
    if (imageReceived && alertReceived && volumeConfirmed) socket.close();
  });
  const [code] = await exit;
  assert.equal(code, 0);
}

(async () => {
  await exercise('ok');
  await exercise('layout');
  await exercise('missing');
  await exercise('hung');
  console.log('Six actions, key press variants, diagnostics and worker failures verified');
})().catch(error => { console.error(error); process.exitCode = 1; });
