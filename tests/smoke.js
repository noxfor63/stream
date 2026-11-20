// Linux integration check with a simulated Windows worker and a local Stream Dock host.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const root = path.resolve(__dirname, '../io.noxfor63.yandexmusic.sdPlugin');
const {WebSocketServer} = require(path.join(root, 'vendor/ws'));
const manifest = require(path.join(root, 'manifest.json'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-test-'));
const executable = path.join(tmp, 'Noxfor63/YandexMusicDock/venv/Scripts/python.exe');
fs.mkdirSync(path.dirname(executable), {recursive: true});
fs.writeFileSync(executable, `#!/usr/bin/env node
require('readline').createInterface({input:process.stdin}).on('line', line => {
  const msg=JSON.parse(line);
  require('fs').appendFileSync(process.env.TEST_LOG, msg.action+'\\n');
  console.log(JSON.stringify({...msg,image:'sample-card'}));
});`, {mode:0o755});
const server = new WebSocketServer({host:'127.0.0.1', port:0});
const log = path.join(tmp, 'commands');
let child;
const timeout = setTimeout(() => {child?.kill(); throw Error('No response from plugin');}, 8000);
server.on('listening', () => {
  child = spawn(process.execPath, [path.join(root, 'index.js'), '-port', server.address().port,
    '-pluginUUID','test','-registerEvent','registerPlugin'], {env:{...process.env, LOCALAPPDATA:tmp, TEST_LOG:log}});
});
server.on('connection', socket => socket.on('message', raw => {
  const msg = JSON.parse(raw);
  if (msg.event === 'registerPlugin') {
    assert.equal(msg.uuid, 'test');
    assert.equal(manifest.Actions.length, 6);
    for (const {UUID:action, Icon} of manifest.Actions) {
      assert.ok(fs.existsSync(path.join(root, Icon)));
      socket.send(JSON.stringify({action, context:action, event:action.endsWith('.track')?'willAppear':'keyDown'}));
    }
  } else if (msg.event === 'setImage') {
    assert.equal(msg.payload.image,'sample-card');
    assert.ok(msg.context.endsWith('.track'));
    child.once('exit', code => {
      clearTimeout(timeout);
      assert.equal(code,0);
      assert.deepEqual([...new Set(fs.readFileSync(log,'utf8').trim().split('\n'))].sort(),
        ['louder','next','previous','quieter','toggle','track']);
      fs.rmSync(tmp,{recursive:true,force:true});
      console.log('Six actions verified');
    });
    // Confirm commands have reached the worker before closing the host.
    const drain = setInterval(() => {
      if (fs.readFileSync(log,'utf8').trim().split('\n').length >= 6) {
        clearInterval(drain); socket.close(); server.close();
      }
    },10);
  }
}));
