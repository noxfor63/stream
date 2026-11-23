'use strict';
const tile = document.getElementById('tile');

function connectElgatoStreamDeckSocket(port, uuid, registration, appInfo, actionInfo) {
  const info = typeof actionInfo === 'string' ? JSON.parse(actionInfo) : actionInfo;
  let settings = info.payload?.settings || {};
  function render() {
    tile.value = String(settings.tile ?? 'auto');
    if (tile.selectedIndex < 0) tile.value = 'auto';
  }
  render();
  const ws = new WebSocket('ws://127.0.0.1:' + port);
  ws.onopen = () => {
    ws.send(JSON.stringify({event: registration, uuid}));
    ws.send(JSON.stringify({event: 'getSettings', context: uuid}));
    tile.disabled = false;
  };
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.event === 'didReceiveSettings') {
      settings = message.payload.settings || {};
      render();
    }
  };
  tile.onchange = () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    settings = {...settings, tile: tile.value};
    ws.send(JSON.stringify({event: 'setSettings', context: uuid, payload: settings}));
    ws.send(JSON.stringify({event: 'sendToPlugin', context: uuid, action: info.action,
      payload: {keyContext: info.context, tile: tile.value}}));
  };
  ws.onclose = () => { tile.disabled = true; };
}
// Some Mirabox hosts use the shorter SDK entry point.
window.connectSocket = connectElgatoStreamDeckSocket;
