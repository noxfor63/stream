// The same drawing code runs in the extension worker for every Stream Dock device.
(() => {
  'use strict';
  const keySize = 144;
  const font = '"Segoe UI", Arial, sans-serif';
  // The worker renders one frame at a time. Reuse its eight drawing surfaces
  // instead of allocating new canvases for every video frame.
  const surfaces = new Map();
  function surface(name, width, height) {
    if (!surfaces.has(name)) surfaces.set(name, new OffscreenCanvas(width, height));
    return surfaces.get(name);
  }

  function timeLabel(seconds) {
    const whole = Math.floor(Math.max(0, seconds));
    const minutes = Math.floor(whole / 60);
    const sec = String(whole % 60).padStart(2, '0');
    if (minutes < 60) return minutes + ':' + sec;
    return Math.floor(minutes / 60) + ':' + String(minutes % 60).padStart(2, '0') + ':' + sec;
  }

  function textLine(ctx, value, x, y, maxWidth, size, bold, color) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text || maxWidth <= 0) return;
    ctx.font = (bold ? '600 ' : '400 ') + size + 'px ' + font;
    ctx.fillStyle = color;
    if (ctx.measureText(text).width <= maxWidth) {
      ctx.fillText(text, x, y);
      return;
    }
    // Find a fitting prefix without splitting UTF-16 surrogate pairs.
    const chars = Array.from(text);
    let low = 0;
    let high = chars.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (ctx.measureText(chars.slice(0, mid).join('') + '…').width <= maxWidth) low = mid;
      else high = mid - 1;
    }
    ctx.fillText(chars.slice(0, low).join('') + '…', x, y);
  }

  function drawCover(ctx, width, height, artwork) {
    const background = ctx.createLinearGradient(0, 0, width, height);
    background.addColorStop(0, '#234f60');
    background.addColorStop(1, '#101e2c');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
    if (artwork?.width > 0 && artwork?.height > 0) {
      const scale = Math.max(width / artwork.width, height / artwork.height);
      const w = artwork.width * scale;
      const h = artwork.height * scale;
      ctx.drawImage(artwork, (width - w) / 2, (height - h) / 2, w, h);
    }
    const shade = ctx.createLinearGradient(0, 0, 0, height);
    shade.addColorStop(0, 'rgba(6,12,22,0.66)');
    shade.addColorStop(0.26, 'rgba(6,12,22,0.04)');
    shade.addColorStop(0.58, 'rgba(6,12,22,0.77)');
    shade.addColorStop(1, 'rgba(6,12,22,0.98)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, width, height);
  }

  function drawState(ctx, x, y, size, paused) {
    ctx.fillStyle = '#fff';
    if (paused) {
      ctx.fillRect(x, y, size / 3, size);
      ctx.fillRect(x + 2 * size / 3, y, size / 3, size);
    } else {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + size, y + size / 2);
      ctx.lineTo(x, y + size);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawPlayer(state, artwork, single) {
    const width = keySize * (single ? 1 : 3);
    const height = keySize * (single ? 1 : 2);
    const canvas = surface(single ? 'single' : 'large', width, height);
    const ctx = canvas.getContext('2d', {alpha: false});
    const left = single ? 7 : 14;
    const textWidth = width - 2 * left;
    drawCover(ctx, width, height, artwork);
    if (!state) {
      // Keep the full-size instruction on one side of the horizontal key bezel.
      textLine(ctx, 'Нет медиа', left, single ? 81 : 187, textWidth, single ? 20 : 33, true, '#fff');
      textLine(ctx, 'Включите плеер', left, single ? 105 : 225, textWidth, single ? 15 : 23, false, '#dce6ec');
      return canvas;
    }

    const sourceSize = single ? 14 : 20;
    textLine(ctx, state.source, left, single ? 20 : 30, textWidth - sourceSize * 2,
      sourceSize, true, '#fff');
    drawState(ctx, width - left - sourceSize, single ? 7 : 13, sourceSize, state.paused);
    const artist = state.artist && state.artist !== state.title ? state.artist : '';
    textLine(ctx, state.title || 'Медиа', left, single ? 79 : 183, textWidth, single ? 20 : 32, true, '#fff');
    textLine(ctx, artist, left, single ? 99 : 212, textWidth, single ? 15 : 22, false, '#dce6ec');

    const hasDuration = Number.isFinite(state.duration) && state.duration > 0;
    const hasPosition = Number.isFinite(state.position) && state.position >= 0;
    if (!state.live && hasDuration && hasPosition) {
      const amount = Math.min(1, state.position / state.duration);
      const barY = single ? 113 : 234;
      const barHeight = single ? 3 : 5;
      ctx.fillStyle = '#57616e';
      ctx.fillRect(left, barY, textWidth, barHeight);
      ctx.fillStyle = '#69e0c2';
      ctx.fillRect(left, barY, textWidth * amount, barHeight);
    }
    let time = state.videoUnavailable ? 'Кадр недоступен' : state.live ? 'Эфир' : '';
    if (!time && hasPosition) {
      time = timeLabel(hasDuration ? Math.min(state.duration, state.position) : state.position);
      if (hasDuration) time += ' / ' + timeLabel(state.duration);
    }
    textLine(ctx, time, left, single ? 136 : 270, textWidth, single ? 14 : 21, false, '#edf2f5');
    return canvas;
  }

  function drawVideo(frame, single) {
    const width = keySize * (single ? 1 : 3);
    const height = keySize * (single ? 1 : 2);
    const canvas = surface(single ? 'single' : 'large', width, height);
    const ctx = canvas.getContext('2d', {alpha: false});
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    const scale = Math.min(width / frame.width, height / frame.height);
    const w = Math.round(frame.width * scale);
    const h = Math.round(frame.height * scale);
    ctx.drawImage(frame, Math.floor((width - w) / 2), Math.floor((height - h) / 2), w, h);
    return canvas;
  }

  async function png(canvas) {
    const blob = await canvas.convertToBlob({type: 'image/png'});
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  globalThis.renderPlayer = async function renderPlayer(state, artwork = null, videoFrame = null) {
    const draw = videoFrame?.width > 0 && videoFrame?.height > 0
      ? single => drawVideo(videoFrame, single)
      : single => drawPlayer(state, artwork, single);
    const large = draw(false);
    const parts = [];
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) {
        const tile = surface('tile' + (row * 3 + col), keySize, keySize);
        const ctx = tile.getContext('2d', {alpha: false});
        ctx.drawImage(large, col * keySize, row * keySize, keySize, keySize, 0, 0, keySize, keySize);
        parts.push(png(tile));
      }
    }
    const [tiles, single] = await Promise.all([Promise.all(parts), png(draw(true))]);
    return {tiles, single};
  };
})();
