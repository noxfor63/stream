// Test-only substitute for Chrome extension ports. It runs the original content
// scripts in a normal page when managed Chromium disallows unpacked extensions.
(() => {
  const endpoint = globalThis.__testEndpoint;
  const tabId = globalThis.__testTabId;
  const event = () => {
    const listeners = [];
    return {addListener: fn => listeners.push(fn), emit: value => listeners.forEach(fn => fn(value))};
  };
  globalThis.chrome = {runtime: {
    id: 'jfglpkafjfnniknfhmjnhamjnbgbijai',
    connect: ({name}) => {
      const query = new URLSearchParams({name, tab: tabId, frame: window === window.top ? 0 : 1});
      const ws = new WebSocket(endpoint + '/content?' + query);
      const onMessage = event(), onDisconnect = event(), buffered = [];
      ws.onopen = () => { for (const message of buffered) ws.send(message); };
      ws.onmessage = e => onMessage.emit(JSON.parse(e.data));
      ws.onclose = () => onDisconnect.emit();
      return {onMessage, onDisconnect,
        postMessage(value) {
          const encoded = JSON.stringify(value);
          if (ws.readyState === WebSocket.CONNECTING) buffered.push(encoded);
          else if (ws.readyState === WebSocket.OPEN) ws.send(encoded);
          else throw Error('Disconnected');
        },
        disconnect() { ws.close(); }
      };
    }
  }};
})();
