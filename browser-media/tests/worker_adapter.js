(() => {
// The JS logic and rendering run unchanged in a real browser Worker. Only the
// Chrome runtime/alarms and extension WebSocket origin are supplied by the test.
const listeners = [];
const channels = new Map();
const messages = [];
const event = () => {
  const handlers = [];
  return {addListener: fn => handlers.push(fn), emit: value => handlers.forEach(fn => fn(value))};
};
const endpoint = location.origin.replace('http:', 'ws:');
const bus = new WebSocket(endpoint + '/runtime');
globalThis.chrome = {
  runtime: {id: 'jfglpkafjfnniknfhmjnhamjnbgbijai',
    onMessage: {addListener: fn => messages.push(fn)}, onConnect: {addListener: fn => listeners.push(fn)}, onStartup: {addListener() {}}},
  alarms: {create() {}, onAlarm: {addListener() {}}}
};
bus.onmessage = e => {
  const data = JSON.parse(e.data);
  if (data.type === 'api') {
    for (const handler of messages) handler(data.message, {id:chrome.runtime.id}, result =>
      bus.send(JSON.stringify({type:'apiResult', id:data.id, result})));
  } else if (data.type === 'connect') {
    const port = {name: data.name, sender: data.sender, onMessage: event(), onDisconnect: event(),
      postMessage: message => bus.send(JSON.stringify({id: data.id, message}))};
    channels.set(data.id, port);
    for (const handler of listeners) handler(port);
  } else if (data.type === 'message') {
    channels.get(data.id)?.onMessage.emit(data.message);
  } else if (data.type === 'disconnect') {
    channels.get(data.id)?.onDisconnect.emit();
    channels.delete(data.id);
  }
};
const BrowserSocket = WebSocket;
globalThis.WebSocket = class extends BrowserSocket {
  constructor(url) {
    super(url === 'ws://127.0.0.1:18765/browser-media' ? endpoint + '/extension' : url);
  }
};

})();
