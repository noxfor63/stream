'use strict';
const status = document.getElementById('status');
const player = document.getElementById('player');
const fps = document.getElementById('fps');
const help = document.getElementById('help');

function show(info) {
  if (!info || info.error) throw new Error('Settings unavailable');
  status.textContent = info.connected ? 'Связь со Stream Dock установлена' : 'Нет связи. Откройте Stream Dock.';
  const options = info.players.map(item => {
    const option = document.createElement('option');
    option.value = item.key;
    option.textContent = item.title + ' — ' + item.source;
    return option;
  });
  player.replaceChildren(...options);
  player.disabled = !options.length;
  player.value = info.selected || '';
  fps.value = String(info.fps);
  fps.disabled = false;
  help.textContent = options.length
    ? 'Сменить плеер можно также кнопкой на панели.'
    : 'Включите ролик или музыку. После установки расширения обновите вкладку с плеером.';
}
async function update(message) {
  try {
    show(await chrome.runtime.sendMessage(message));
  } catch {
    status.textContent = 'Не удалось получить настройки. Откройте это окно ещё раз.';
  }
}
player.onchange = () => update({type:'select', key:player.value});
fps.onchange = () => update({type:'fps', fps:Number(fps.value)});
update({type:'status'});
setInterval(() => {
  if (document.activeElement !== player && document.activeElement !== fps) update({type:'status'});
}, 2000);
