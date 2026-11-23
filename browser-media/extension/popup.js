'use strict';
const status = document.getElementById('status');
const player = document.getElementById('player');
const help = document.getElementById('help');

function show(info) {
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
  help.textContent = options.length
    ? 'Сменить плеер можно также кнопкой на панели.'
    : 'Включите ролик или музыку. После установки расширения обновите вкладку с плеером.';
}
async function update(message) {
  try {
    show(await chrome.runtime.sendMessage(message));
  } catch {
    status.textContent = 'Расширение перезапускается. Откройте это окно ещё раз.';
  }
}
player.onchange = () => update({type:'select', key:player.value});
update({type:'status'});
setInterval(() => {
  if (document.activeElement !== player) update({type:'status'});
}, 2000);
