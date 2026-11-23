// Run with Node.js. Models Stream Dock and a Chromium extension over real local WebSockets.
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {setTimeout: wait} = require('node:timers/promises');
const root = path.resolve(__dirname, '../com.noxfor63.streamdock.browsermedia.sdPlugin');
const WebSocket = require(path.join(root,'vendor/ws'));
const {layout} = require(path.join(root,'layout'));
const manifest = require(path.join(root,'manifest.json'));
const origin = 'chrome-extension://jfglpkafjfnniknfhmjnhamjnbgbijai';
const url = 'ws://127.0.0.1:18765/browser-media';
const action = name => 'com.noxfor63.streamdock.browsermedia.' + name;
async function until(condition) {
  for (let i=0; i<200; i++) {
    if (condition()) return;
    await wait(10);
  }
  throw new Error('Timed out waiting for a plugin event');
}

async function connect(address, options) {
  const socket = new WebSocket(address, options);
  await once(socket, 'open');
  return socket;
}

function checkLayout() {
  const cards = new Map();
  for (let i=0; i<6; i++) {
    cards.set(i, {x:2+i%3, y:1+Math.floor(i/3), device:'A', tile:null});
    cards.set(6+i, {x:2+i%3, y:1+Math.floor(i/3), device:'B', tile:null});
  }
  cards.set('unknown', {device:null, tile:5});
  assert.deepEqual([...layout(cards).values()], [0,0,1,1,2,2,3,3,4,4,5,5,5]);
  cards.delete(1);
  assert.equal(layout(cards).get(0), null);
  assert.equal(layout(cards).get(6), 0);
  cards.set('duplicate', {x:2, y:1, device:'B', tile:null});
  assert.equal(layout(cards).get(6), null);
}

async function main() {
  checkLayout();
  const host = new WebSocket.WebSocketServer({host:'127.0.0.1', port:0});
  await once(host,'listening');
  const images = new Map();
  const titles = new Map();
  const alerts = [];
  let extension;
  const child = spawn(process.execPath,[path.join(root,manifest.CodePathWin),'-port',host.address().port,
    '-pluginUUID','test-uuid','-registerEvent','registerPlugin','-info','{}'],{stdio:'inherit'});
  const exit = once(child, 'exit');
  try {
    const [dock] = await once(host,'connection');
    let registration;
    dock.on('message', raw => {
      const msg = JSON.parse(raw);
      if (msg.event==='registerPlugin') registration=msg;
      if (msg.event==='setImage') images.set(msg.context, msg.payload.image);
      if (msg.event==='setTitle') titles.set(msg.context, msg.payload.title);
      if (msg.event==='showAlert') alerts.push(msg.context);
    });
    await until(()=>registration);
    assert.equal(registration.uuid,'test-uuid');
    const key = (event, name, context, payload) => dock.send(JSON.stringify({event,action:action(name),context,device:'D',payload}));
    for (let i=0; i<6; i++) {
      key('willAppear','player','p'+i,{coordinates:{row:Math.floor(i/3),column:String(i%3)},settings:{}});
    }
    key('willAppear','player','manual',{settings:{tile:'5'}});
    key('willAppear','player','single',{settings:{}});
    await until(()=>titles.get('manual')==='Нет связи');
    await assert.rejects(connect(url,{origin:'https://example.org'}));
    await assert.rejects(connect(url+'/other',{origin}));
    extension = await connect(url,{origin});
    // Use real PNG fixtures for the single image and different tile positions.
    const png = name => 'data:image/png;base64,' + fs.readFileSync(path.join(root,'icons',name+'.png')).toString('base64');
    const frame = {type:'frame',single:png('player'),tiles:['toggle','back','forward','quieter','louder','mute'].map(png)};
    extension.send(JSON.stringify(frame));
    await until(()=>images.get('p5')===frame.tiles[5] && images.get('single')===frame.single);
    for (let i=0; i<6; i++) assert.equal(images.get('p'+i),frame.tiles[i]);
    assert.equal(images.get('manual'),frame.tiles[5]);
    key('didReceiveSettings','player','manual',{settings:{tile:'2'}});
    await until(()=>images.get('manual')===frame.tiles[2]);
    key('willDisappear','player','p3');
    await until(()=>images.get('p4')===frame.single);
    const replies = [];
    extension.on('message', raw => {
      const msg=JSON.parse(raw);
      replies.push(msg);
      if (msg.type==='command') extension.send(JSON.stringify({type:'result',id:msg.id,ok:msg.action!=='back'}));
    });
    extension.send('{"type":"ping"}');
    const buttons = manifest.Actions.map(item=>item.UUID.split('.').at(-1)).filter(name=>name!=='player');
    for (const name of buttons) {
      if (name!=='cycle') key('keyDown',name,name);
      key('keyUp',name,name);
    }
    await until(()=>alerts.includes('back') && replies.some(m=>m.action==='cycle') && replies.some(m=>m.type==='pong'));
    assert.deepEqual(replies.filter(m=>m.type==='command').map(m=>m.action),buttons);
    extension.close();
    await until(()=>titles.get('p0')==='Нет связи' && images.get('manual')==='');
    key('keyDown','louder','offline');
    await until(()=>alerts.includes('offline'));
    dock.close();
    assert.equal((await exit)[0],0);
    console.log('3×2 tile routing, manual selection, origin checks, seven controls, disconnected state verified');
  } finally {
    extension?.terminate();
    child.kill();
    for (const socket of host.clients) socket.terminate();
    host.close();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
