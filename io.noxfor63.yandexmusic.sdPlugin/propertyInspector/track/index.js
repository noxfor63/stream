'use strict';
const corner = document.getElementById('corner');

function connectElgatoStreamDeckSocket(port, uuid, registration, appInfo, actionInfo) {
  const info = typeof actionInfo === 'string' ? JSON.parse(actionInfo) : actionInfo;
  let settings = info.payload?.settings || {};
  function render() {
    corner.value = settings.coverCorner || 'auto';
    if (corner.selectedIndex < 0) corner.value = 'auto';
  }
  render();
  const ws = new WebSocket('ws://127.0.0.1:' + port);
  ws.onopen = () => {
    ws.send(JSON.stringify({event: registration, uuid}));
    ws.send(JSON.stringify({event: 'getSettings', context: uuid}));
    corner.disabled = false;
  };
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.event === 'didReceiveSettings') {
      settings = message.payload.settings || {};
      render();
    }
  };
  corner.onchange = () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    settings = {...settings, coverCorner: corner.value};
    ws.send(JSON.stringify({event: 'setSettings', context: uuid, payload: settings}));
    ws.send(JSON.stringify({event: 'sendToPlugin', context: uuid, action: info.action,
      payload: {trackContext: info.context, coverCorner: corner.value}}));
  };
  ws.onclose = () => { corner.disabled = true; };
}
// Some Mirabox hosts use the shorter SDK entry point.
window.connectSocket = connectElgatoStreamDeckSocket;
