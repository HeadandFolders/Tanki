import { CONFIG, homeTerritoryBounds } from './config';
import { cardinalAngle, eagleAnchor } from './arena';
import { tankSeesPoint, visionContributors } from './fog';
import type { Tank, WorldState } from './types';

const TANK_UP = [
  '......B......',
  '......B......',
  '.....BBB.....',
  '..TT.BBB.TT..',
  '..TTTTTTTTT..',
  '..TTBBBBBTT..',
  '..TTBBBBBTT..',
  '..TTBBBBBTT..',
  '..TTTTTTTTT..',
  '..TT.....TT..',
  '..TT.....TT..',
  '..TTTTTTTTT..',
  '.............',
];

function facingIndex(angle: number): number {
  const card = cardinalAngle(angle);
  if (card < -0.5) return 0;
  if (Math.abs(card) < 0.5) return 1;
  if (card > 2) return 3;
  return 2;
}

function rotCell(px: number, py: number, dir: number): [number, number] {
  const cx = px - 6;
  const cy = py - 6;
  let rx = cx;
  let ry = cy;
  if (dir === 1) {
    rx = -cy;
    ry = cx;
  } else if (dir === 2) {
    rx = -cx;
    ry = -cy;
  } else if (dir === 3) {
    rx = cy;
    ry = -cx;
  }
  return [rx + 6, ry + 6];
}

function tankPalette(tank: Tank) {
  if (tank.team === 'red') {
    return { body: '#d0d4d8', barrel: '#f2f4f6', tread: '#5c6166', dark: '#2c3034' };
  }
  if (tank.role === 'scout') {
    return { body: '#d6de62', barrel: '#f3f6a4', tread: '#5c6820', dark: '#2a320c' };
  }
  return { body: '#f0c84a', barrel: '#ffe9a0', tread: '#7a5a14', dark: '#3a2a08' };
}

function drawTankSprite(ctx: CanvasRenderingContext2D, tank: Tank) {
  const pal = tankPalette(tank);
  const dir = facingIndex(tank.angle);
  const scale = 2;
  const originX = Math.round(tank.x) - 13;
  const originY = Math.round(tank.y) - 13;
  for (let y = 0; y < 13; y++) {
    const row = TANK_UP[y] ?? '';
    for (let x = 0; x < 13; x++) {
      const ch = row[x];
      if (!ch || ch === '.') continue;
      const [rx, ry] = rotCell(x, y, dir);
      let color = pal.body;
      if (ch === 'T') color = pal.tread;
      else if (ch === 'B') color = pal.barrel;
      if (tank.hurtFlash > 0) color = '#ffffff';
      ctx.fillStyle = color;
      ctx.fillRect(originX + rx * scale, originY + ry * scale, scale, scale);
    }
  }
  ctx.fillStyle = pal.dark;
  ctx.fillRect(originX + 12, originY + 12, 2, 2);
}

function drawBrick(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.fillStyle = '#9a3d12';
  ctx.fillRect(x, y, w, h);
  const bw = 8;
  const bh = 4;
  for (let ty = 0; ty < h; ty += bh) {
    const row = Math.floor(ty / bh);
    const offset = row % 2 === 0 ? 0 : 4;
    for (let tx = -bw; tx < w; tx += bw) {
      const px = x + tx + offset;
      if (px + bw <= x || px >= x + w) continue;
      const left = Math.max(px, x);
      const right = Math.min(px + bw, x + w);
      ctx.fillStyle = (row + Math.floor(tx / bw)) % 2 === 0 ? '#d86a32' : '#c45522';
      ctx.fillRect(left, y + ty, right - left, Math.min(bh, h - ty));
    }
  }
  ctx.strokeStyle = '#3a1408';
  ctx.lineWidth = 1;
  for (let ty = bh; ty < h; ty += bh) {
    ctx.beginPath();
    ctx.moveTo(x, y + ty + 0.5);
    ctx.lineTo(x + w, y + ty + 0.5);
    ctx.stroke();
  }
}

function drawSteel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.fillStyle = '#8b9298';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#555b61';
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  ctx.fillStyle = '#e4e7ea';
  const rivets = [
    [4, 4],
    [w - 6, 4],
    [4, h - 6],
    [w - 6, h - 6],
  ];
  for (const [rx, ry] of rivets) {
    ctx.fillRect(x + rx, y + ry, 2, 2);
  }
}

function drawBorder(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.fillStyle = '#3c3c3c';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#2a2a2a';
  const s = 16;
  for (let ty = 0; ty < h; ty += s) {
    for (let tx = 0; tx < w; tx += s) {
      if (((tx + ty) / s) % 2 === 0) ctx.fillRect(x + tx, y + ty, Math.min(s, w - tx), Math.min(s, h - ty));
    }
  }
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

function drawEagle(ctx: CanvasRenderingContext2D) {
  const a = eagleAnchor();
  const px = [
    '....####....',
    '...######...',
    '..##.####...',
    '.###..####..',
    '####..#####.',
    '.#########..',
    '..#######...',
    '...#####....',
    '....###.....',
    '...#####....',
    '..##.#.##...',
    '...#...#....',
  ];
  for (let y = 0; y < px.length; y++) {
    const row = px[y] ?? '';
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== '#') continue;
      ctx.fillStyle = y < 8 ? '#f0c84a' : '#8a5a18';
      ctx.fillRect(a.x - 12 + x * 2, a.y - 18 + y * 2, 2, 2);
    }
  }
}

function enemyLive(world: WorldState, tank: Tank): boolean {
  return visionContributors(world).some((mate) => tankSeesPoint(mate, tank.x, tank.y, world.walls));
}

function drawHp(ctx: CanvasRenderingContext2D, tank: Tank) {
  const w = 22;
  const x = Math.round(tank.x) - w / 2;
  const y = Math.round(tank.y) - 20;
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(x, y, w, 3);
  const ratio = Math.max(0, tank.hp / tank.maxHp);
  ctx.fillStyle = ratio > 0.45 ? '#7dce4a' : '#e04b3a';
  ctx.fillRect(x, y, Math.round(w * ratio), 3);
}

function drawRole(ctx: CanvasRenderingContext2D, tank: Tank) {
  ctx.fillStyle = '#111';
  ctx.font = 'bold 8px "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(tank.role === 'scout' ? 'S' : 'G', Math.round(tank.x), Math.round(tank.y) + 1);
}

export function render(ctx: CanvasRenderingContext2D, world: WorldState, aimX: number, aimY: number) {
  const w = CONFIG.canvasWidth;
  const h = CONFIG.canvasHeight;
  ctx.imageSmoothingEnabled = false;
  const tile = CONFIG.tileSize;
  for (let y = 0; y < h; y += tile) {
    for (let x = 0; x < w; x += tile) {
      const alt = (x / tile + y / tile) % 2 === 0;
      ctx.fillStyle = alt ? '#2a2a2a' : '#242424';
      ctx.fillRect(x, y, tile, tile);
    }
  }
  const home = homeTerritoryBounds();
  ctx.fillStyle = 'rgba(210, 170, 60, 0.10)';
  ctx.fillRect(home.x, home.y, home.w, home.h);

  for (const wall of world.walls) {
    if (wall.kind === 'brick') drawBrick(ctx, wall.x, wall.y, wall.w, wall.h);
    else if (wall.kind === 'steel') drawSteel(ctx, wall.x, wall.y, wall.w, wall.h);
    else drawBorder(ctx, wall.x, wall.y, wall.w, wall.h);
  }
  drawEagle(ctx);

  for (const wreck of world.wrecks) {
    const col = Math.floor(wreck.x / CONFIG.fogCell);
    const row = Math.floor(wreck.y / CONFIG.fogCell);
    const idx = row * world.fogCols + col;
    if (world.fog[idx] !== 1 && world.live[idx] !== 1) continue;
    ctx.fillStyle = wreck.team === 'blue' ? '#6a5420' : '#4a4e52';
    ctx.fillRect(wreck.x - 8, wreck.y - 8, 16, 16);
    ctx.strokeStyle = wreck.marked ? '#f0c84a' : '#222';
    ctx.lineWidth = wreck.marked ? 2 : 1;
    ctx.strokeRect(wreck.x - 9, wreck.y - 9, 18, 18);
    ctx.fillStyle = '#f4e2a8';
    ctx.font = 'bold 10px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(wreck.label, wreck.x, wreck.y);
    const showCode = wreck.debugResult === 'code' || (wreck.team === 'blue' && wreck.wasCodeCarrier);
    if (showCode) {
      ctx.fillStyle = '#ffe27a';
      ctx.fillText('★', wreck.x, wreck.y - 14);
    }
  }

  for (const tank of world.tanks) {
    if (!tank.alive || tank.team !== 'red') continue;
    if (!enemyLive(world, tank)) continue;
    drawTankSprite(ctx, tank);
    drawHp(ctx, tank);
    drawRole(ctx, tank);
  }

  for (const p of world.projectiles) {
    ctx.fillStyle = p.team === 'blue' ? '#ffe27a' : '#f2f2f2';
    ctx.fillRect(Math.round(p.x) - 2, Math.round(p.y) - 2, 4, 4);
  }

  const cell = CONFIG.fogCell;
  for (let row = 0; row < world.fogRows; row++) {
    for (let col = 0; col < world.fogCols; col++) {
      const idx = row * world.fogCols + col;
      const explored = world.fog[idx] === 1;
      const live = world.live[idx] === 1;
      if (live) {
        ctx.fillStyle = 'rgba(255, 214, 90, 0.05)';
        ctx.fillRect(col * cell, row * cell, cell, cell);
        continue;
      }
      ctx.fillStyle = '#050508';
      ctx.globalAlpha = explored ? CONFIG.exploredAlpha : CONFIG.hiddenAlpha;
      ctx.fillRect(col * cell, row * cell, cell, cell);
      ctx.globalAlpha = 1;
    }
  }

  ctx.save();
  ctx.strokeStyle = 'rgba(240, 200, 74, 0.85)';
  ctx.setLineDash([6, 6]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(16, home.y + 0.5);
  ctx.lineTo(w - 16, home.y + 0.5);
  ctx.stroke();
  ctx.restore();

  for (const m of world.markers) {
    const alpha = Math.max(0, Math.min(1, m.life / CONFIG.markerFadeSeconds));
    ctx.save();
    ctx.globalAlpha = 0.35 + alpha * 0.65;
    ctx.translate(m.x, m.y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = m.kind === 'enemy' ? '#d0d4d8' : '#e08a45';
    ctx.fillRect(-4, -4, 8, 8);
    ctx.restore();
    if (m.label) {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#f0c84a';
      ctx.font = '9px "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(m.label, m.x, m.y - 10);
      ctx.globalAlpha = 1;
    }
  }

  for (const tank of world.tanks) {
    if (!tank.alive || tank.team !== 'blue') continue;
    drawTankSprite(ctx, tank);
    if (tank.id === world.controlledId) {
      ctx.strokeStyle = '#ffe27a';
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(tank.x) - 16, Math.round(tank.y) - 16, 32, 32);
    }
    drawHp(ctx, tank);
    drawRole(ctx, tank);
    if (tank.isCodeCarrier) {
      ctx.fillStyle = '#ffe27a';
      ctx.font = '11px "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('★', tank.x, tank.y - 24);
    }
    if (tank.debugProgress > 0 && tank.debugWreckId) {
      ctx.beginPath();
      ctx.strokeStyle = '#7dce4a';
      ctx.lineWidth = 2;
      ctx.arc(tank.x, tank.y, 16, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * tank.debugProgress);
      ctx.stroke();
    }
  }

  const controlled = world.tanks.find((t) => t.id === world.controlledId && t.alive);
  if (controlled && world.phase === 'playing') {
    ctx.save();
    ctx.strokeStyle = 'rgba(240, 200, 74, 0.9)';
    ctx.setLineDash([3, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(controlled.x, controlled.y);
    ctx.lineTo(aimX, aimY);
    ctx.stroke();
    ctx.restore();
  }

  if (world.phase !== 'playing') {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = world.phase === 'lose' ? '#ff6b5a' : '#f0c84a';
    ctx.font = 'bold 42px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const title = world.phase === 'win' ? 'STAGE CLEAR' : world.phase === 'lose' ? 'GAME OVER' : 'DRAW';
    ctx.fillText(title, w / 2, h / 2 - 18);
    ctx.fillStyle = '#f4e2a8';
    ctx.font = '16px "Courier New", monospace';
    ctx.fillText(world.endReason, w / 2, h / 2 + 16);
    ctx.fillText('PRESS RESTART', w / 2, h / 2 + 42);
  }
}
