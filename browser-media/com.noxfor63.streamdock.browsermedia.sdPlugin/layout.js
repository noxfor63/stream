'use strict';

function coordinate(value) {
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

// A manual position is independent of the grid and also works on hosts which
// omit coordinates. An auto tile joins only a complete, unambiguous 3×2 block.
function layout(cards) {
  const result = new Map();
  const devices = new Map();
  for (const [context, card] of cards) {
    result.set(context, card.tile);
    if (!card.device || card.x === undefined || card.y === undefined) continue;
    if (!devices.has(card.device)) devices.set(card.device, new Map());
    const grid = devices.get(card.device);
    const pos = card.x + ',' + card.y;
    if (!grid.has(pos)) grid.set(pos, []);
    grid.get(pos).push(context);
  }
  for (const grid of devices.values()) {
    while (grid.size) {
      const first = grid.keys().next().value;
      const stack = [first];
      const group = [];
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      let unique = true;
      while (stack.length) {
        const pos = stack.pop();
        const contexts = grid.get(pos);
        if (!contexts) continue;
        grid.delete(pos);
        const [x, y] = pos.split(',').map(Number);
        group.push([contexts[0], x, y]);
        unique &&= contexts.length === 1;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        stack.push((x+1)+','+y, (x-1)+','+y, x+','+(y+1), x+','+(y-1));
      }
      if (unique && group.length === 6 && right-left === 2 && bottom-top === 1) {
        for (const [context, x, y] of group) {
          if (result.get(context) === null) result.set(context, 3*(y-top) + x-left);
        }
      }
    }
  }
  return result;
}

module.exports = {coordinate, layout};
