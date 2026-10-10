import { CONFIG, homeTerritoryBounds } from "./config";
import { cardinalAngle, dist, eaglePosition } from "./arena";
import { canSeeTank } from "./fog";
import type { Tank, Wall, WorldState } from "./types";

export function renderWorld(
  ctx: CanvasRenderingContext2D,
  world: WorldState,
  mouseX: number,
  mouseY: number,
): void {
  const W = CONFIG.canvasWidth;
  const H = CONFIG.canvasHeight;

  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);

  drawFloor(ctx, W, H);
  drawHomeTint(ctx);
  drawWalls(ctx, world);
  drawEagle(ctx, world);

  for (const w of world.wrecks) {
    if (!shouldShowWorldPos(world, w.x, w.y)) continue;
    drawWreck(ctx, w.x, w.y, w.label, w.marked, w.debugged, w.debugResult);
  }

  for (const t of world.tanks) {
    if (!t.alive) continue;
    if (t.team === "blue") drawTank(ctx, world, t, true);
    else if (isEnemyVisible(world, t)) drawTank(ctx, world, t, false);
  }

  for (const p of world.projectiles) {
    if (p.team === "red" && !shouldShowHostile(world, p.x, p.y)) continue;
    drawBullet(ctx, p.x, p.y);
  }

  if (world.shareMode !== "clear") drawFog(ctx, world);
  drawFrontline(ctx);
  drawMarkers(ctx, world);

  const me = world.tanks.find((t) => t.id === world.controlledId && t.alive);
  if (me) {
    ctx.strokeStyle = "rgba(248,240,96,0.45)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(me.x, me.y);
    ctx.lineTo(mouseX, mouseY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (world.outcome !== "playing") {
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = CONFIG.colors.accent;
    ctx.font = "bold 40px monospace";
    ctx.textAlign = "center";
    const msg =
      world.outcome === "win"
        ? "STAGE CLEAR"
        : world.outcome === "lose"
          ? "GAME OVER"
          : "DRAW";
    ctx.fillText(msg, W / 2, H / 2);
    ctx.font = "14px monospace";
    ctx.fillStyle = "#ddd";
    ctx.fillText("PRESS RESTART", W / 2, H / 2 + 32);
    ctx.textAlign = "left";
  }
}

function drawFloor(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  ctx.fillStyle = CONFIG.colors.floor;
  ctx.fillRect(0, 0, W, H);
  const s = CONFIG.tileSize;
  for (let y = 0; y < H; y += s) {
    for (let x = 0; x < W; x += s) {
      if ((x / s + y / s) % 2 === 0) {
        ctx.fillStyle = CONFIG.colors.floorAlt;
        ctx.fillRect(x, y, s, s);
      }
      // micro cobble
      ctx.fillStyle = "rgba(255,255,255,0.03)";
      ctx.fillRect(x + 2, y + 2, 3, 2);
      ctx.fillRect(x + 9, y + 10, 4, 2);
    }
  }
}

function drawHomeTint(ctx: CanvasRenderingContext2D): void {
  const home = homeTerritoryBounds("blue");
  ctx.fillStyle = CONFIG.colors.homeTint;
  ctx.fillRect(0, home.y0, CONFIG.canvasWidth, home.y1 - home.y0);
}

function drawFrontline(ctx: CanvasRenderingContext2D): void {
  const home = homeTerritoryBounds("blue");
  ctx.strokeStyle = CONFIG.colors.frontline;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(CONFIG.tileSize * 2, home.y0);
  ctx.lineTo(CONFIG.canvasWidth - CONFIG.tileSize * 2, home.y0);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawWalls(ctx: CanvasRenderingContext2D, world: WorldState): void {
  for (const w of world.walls) {
    if (w.kind === "brick") drawBrickBlock(ctx, w);
    else if (w.kind === "steel") drawSteelBlock(ctx, w);
    else drawBorderBlock(ctx, w);
  }
}

function drawBrickBlock(ctx: CanvasRenderingContext2D, w: Wall): void {
  const brickH = 4;
  const brickW = 8;
  for (let y = w.y; y < w.y + w.h; y += brickH) {
    const row = Math.floor((y - w.y) / brickH);
    const offset = row % 2 === 0 ? 0 : brickW / 2;
    for (let x = w.x - offset; x < w.x + w.w; x += brickW) {
      const x0 = Math.max(x, w.x);
      const x1 = Math.min(x + brickW - 1, w.x + w.w);
      if (x1 <= x0) continue;
      ctx.fillStyle = CONFIG.colors.brickLight;
      ctx.fillRect(x0, y, x1 - x0, brickH - 1);
      ctx.fillStyle = CONFIG.colors.brickDark;
      ctx.fillRect(x0, y + brickH - 2, x1 - x0, 1);
      ctx.fillStyle = CONFIG.colors.brickMortar;
      ctx.fillRect(x0, y + brickH - 1, x1 - x0, 1);
      if (x > w.x) {
        ctx.fillRect(x0, y, 1, brickH);
      }
    }
  }
}

function drawSteelBlock(ctx: CanvasRenderingContext2D, w: Wall): void {
  const cell = 8;
  for (let y = w.y; y < w.y + w.h; y += cell) {
    for (let x = w.x; x < w.x + w.w; x += cell) {
      const cw = Math.min(cell, w.x + w.w - x);
      const ch = Math.min(cell, w.y + w.h - y);
      ctx.fillStyle = CONFIG.colors.steelMid;
      ctx.fillRect(x, y, cw, ch);
      ctx.fillStyle = CONFIG.colors.steelLight;
      ctx.fillRect(x, y, cw, 1);
      ctx.fillRect(x, y, 1, ch);
      ctx.fillStyle = CONFIG.colors.steelDark;
      ctx.fillRect(x, y + ch - 1, cw, 1);
      ctx.fillRect(x + cw - 1, y, 1, ch);
      // rivets
      ctx.fillStyle = CONFIG.colors.steelLight;
      ctx.fillRect(x + 2, y + 2, 2, 2);
      ctx.fillRect(x + cw - 4, y + 2, 2, 2);
      ctx.fillRect(x + 2, y + ch - 4, 2, 2);
      ctx.fillRect(x + cw - 4, y + ch - 4, 2, 2);
    }
  }
}

function drawBorderBlock(ctx: CanvasRenderingContext2D, w: Wall): void {
  const s = CONFIG.tileSize;
  for (let y = w.y; y < w.y + w.h; y += s) {
    for (let x = w.x; x < w.x + w.w; x += s) {
      ctx.fillStyle = CONFIG.colors.borderDark;
      ctx.fillRect(x, y, s, s);
      ctx.fillStyle = CONFIG.colors.borderLight;
      ctx.fillRect(x + 1, y + 1, s - 2, s - 2);
      ctx.fillStyle = CONFIG.colors.borderDark;
      ctx.fillRect(x + 3, y + 3, s - 6, s - 6);
      ctx.fillStyle = "#b8b8c0";
      ctx.fillRect(x + 5, y + 5, 2, 2);
      ctx.fillRect(x + s - 7, y + s - 7, 2, 2);
    }
  }
}

function drawEagle(ctx: CanvasRenderingContext2D, world: WorldState): void {
  const { x, y } = eaglePosition();
  if (!shouldShowWorldPos(world, x, y)) return;
  // brick-ish pedestal already in walls; draw eagle glyph
  ctx.fillStyle = "#1a1a1a";
  ctx.fillRect(x - 10, y - 10, 20, 20);
  ctx.fillStyle = CONFIG.colors.eagle;
  // simple pixel eagle
  const px = (dx: number, dy: number, w = 2, h = 2) => {
    ctx.fillRect(x + dx, y + dy, w, h);
  };
  px(-2, -8, 4, 2);
  px(-6, -6, 12, 2);
  px(-8, -4, 16, 2);
  px(-4, -2, 8, 4);
  px(-2, 2, 4, 4);
  px(-6, 4, 2, 4);
  px(4, 4, 2, 4);
  ctx.fillStyle = "#802020";
  px(-1, 0, 2, 2);
}

function drawBullet(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = CONFIG.colors.bullet;
  ctx.fillRect(Math.round(x) - 2, Math.round(y) - 2, 4, 4);
}

/**
 * 13×13 Battle City–ish tank pattern (1 = body, 2 = tread, 3 = barrel, 4 = cabin).
 * Drawn facing UP; rotated by cardinal.
 */
const TANK_PAT: number[][] = [
  [0, 0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 0, 0],
  [2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2],
  [2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2],
  [2, 2, 1, 1, 4, 4, 4, 4, 1, 1, 1, 2, 2],
  [2, 2, 1, 1, 4, 4, 4, 4, 1, 1, 1, 2, 2],
  [2, 2, 1, 1, 4, 4, 4, 4, 1, 1, 1, 2, 2],
  [2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2],
  [2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2],
  [2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2],
  [2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2],
  [2, 2, 2, 2, 0, 0, 0, 0, 0, 2, 2, 2, 2],
  [2, 2, 2, 2, 0, 0, 0, 0, 0, 2, 2, 2, 2],
];

function drawTank(
  ctx: CanvasRenderingContext2D,
  world: WorldState,
  t: Tank,
  friendly: boolean,
): void {
  const isScout = t.role === "scout";
  const body = friendly
    ? isScout
      ? CONFIG.colors.playerScout
      : CONFIG.colors.playerTeam
    : isScout
      ? CONFIG.colors.enemyScout
      : CONFIG.colors.enemyTeam;
  const tread = friendly ? "#a08020" : "#707078";
  const cabin = friendly ? "#fff8a0" : "#e8e8f0";
  const barrel = friendly ? "#e8c020" : "#d0d0d8";

  const facing = cardinalAngle(t.angle);
  const scale = CONFIG.spriteScale;
  const n = TANK_PAT.length;
  const size = n * scale;

  ctx.save();
  ctx.translate(Math.round(t.x), Math.round(t.y));
  ctx.rotate(facing + Math.PI / 2); // pattern faces up; 0 rad is right in canvas

  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const cell = TANK_PAT[row]![col]!;
      if (!cell) continue;
      ctx.fillStyle =
        cell === 1 ? body : cell === 2 ? tread : cell === 3 ? barrel : cabin;
      ctx.fillRect(
        col * scale - size / 2,
        row * scale - size / 2,
        scale,
        scale,
      );
    }
  }
  ctx.restore();

  // number
  ctx.fillStyle = "#000";
  ctx.font = "bold 10px monospace";
  ctx.textAlign = "center";
  ctx.fillText(String(t.number), t.x + 1, t.y + 4);
  ctx.fillStyle = "#fff";
  ctx.fillText(String(t.number), t.x, t.y + 3);

  // role tag
  ctx.fillStyle = isScout ? "#c8e060" : CONFIG.colors.accent;
  ctx.font = "bold 9px monospace";
  ctx.fillText(isScout ? "S" : "G", t.x + 14, t.y - 8);

  // HP bar
  const pct = t.hp / t.maxHp;
  ctx.fillStyle = "#000";
  ctx.fillRect(t.x - 12, t.y - 18, 24, 3);
  ctx.fillStyle = pct > 0.35 ? "#40c040" : "#e04040";
  ctx.fillRect(t.x - 12, t.y - 18, 24 * pct, 3);

  if (friendly && t.isCodeCarrier && world.gameMode === "ctf") {
    ctx.fillStyle = CONFIG.colors.codeIcon;
    ctx.fillRect(t.x - 3, t.y - 24, 6, 4);
  }

  if (t.id === world.controlledId) {
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.strokeRect(t.x - size / 2 - 2, t.y - size / 2 - 2, size + 4, size + 4);
  }

  if (t.debugProgress > 0) {
    ctx.strokeStyle = CONFIG.colors.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(
      t.x,
      t.y,
      size / 2 + 4,
      -Math.PI / 2,
      -Math.PI / 2 + t.debugProgress * Math.PI * 2,
    );
    ctx.stroke();
  }

  ctx.textAlign = "left";
}

function drawWreck(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  label: string,
  marked: boolean,
  debugged: boolean,
  result: "clean" | "code" | null,
): void {
  // burnt husk
  ctx.fillStyle = "#403028";
  ctx.fillRect(x - 10, y - 10, 20, 20);
  ctx.fillStyle = CONFIG.colors.wreck;
  ctx.fillRect(x - 8, y - 8, 16, 14);
  ctx.fillStyle = "#201810";
  ctx.fillRect(x - 4, y - 2, 8, 6);
  if (marked) {
    ctx.strokeStyle = CONFIG.colors.marker;
    ctx.lineWidth = 2;
    ctx.strokeRect(x - 12, y - 12, 24, 24);
  }
  ctx.fillStyle = "#f2e6c8";
  ctx.font = "bold 11px monospace";
  ctx.textAlign = "center";
  ctx.fillText(label, x, y + 4);
  if (debugged) {
    ctx.fillStyle = result === "code" ? CONFIG.colors.codeIcon : "#999";
    ctx.font = "9px monospace";
    ctx.fillText(result === "code" ? "CODE" : "clean", x, y + 18);
  }
  ctx.textAlign = "left";
}

function drawFog(ctx: CanvasRenderingContext2D, world: WorldState): void {
  const cell = CONFIG.fog.cellSize;
  const live = new Set<number>();
  const viewers = liveVisionViewers(world);

  for (const v of viewers) {
    const rad = CONFIG.roles[v.role].visionRadius;
    const minC = Math.max(0, Math.floor((v.x - rad) / cell));
    const maxC = Math.min(world.fogCols - 1, Math.floor((v.x + rad) / cell));
    const minR = Math.max(0, Math.floor((v.y - rad) / cell));
    const maxR = Math.min(world.fogRows - 1, Math.floor((v.y + rad) / cell));
    const r2 = rad * rad;
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const cx = c * cell + cell * 0.5;
        const cy = r * cell + cell * 0.5;
        if ((cx - v.x) ** 2 + (cy - v.y) ** 2 <= r2) {
          live.add(r * world.fogCols + c);
        }
      }
    }
  }

  for (let r = 0; r < world.fogRows; r++) {
    for (let c = 0; c < world.fogCols; c++) {
      const i = r * world.fogCols + c;
      if (live.has(i)) continue;
      const explored = world.fogExplored[i] === 1;
      ctx.fillStyle = explored
        ? `rgba(0,0,0,${CONFIG.fog.exploredAlpha})`
        : `rgba(0,0,0,${CONFIG.fog.hiddenAlpha})`;
      ctx.fillRect(c * cell, r * cell, cell + 0.5, cell + 0.5);
    }
  }
}

function drawMarkers(ctx: CanvasRenderingContext2D, world: WorldState): void {
  for (const m of world.markers) {
    const age = world.time - m.createdAt;
    const fade = 1 - age / CONFIG.markerFadeSeconds;
    if (fade <= 0) continue;
    ctx.globalAlpha = Math.max(0.2, fade);
    ctx.strokeStyle = CONFIG.colors.marker;
    ctx.lineWidth = 2;
    ctx.strokeRect(m.x - 12, m.y - 12, 24, 24);
    ctx.fillStyle = CONFIG.colors.marker;
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    ctx.fillText(`${m.label} ${age.toFixed(0)}s`, m.x, m.y - 16);
    ctx.globalAlpha = 1;
    ctx.textAlign = "left";
  }
}

function shouldShowWorldPos(world: WorldState, x: number, y: number): boolean {
  // Clear / no-fog: everything on the map is visible.
  if (world.shareMode === "clear") return true;
  const cell = CONFIG.fog.cellSize;
  const c = Math.floor(x / cell);
  const r = Math.floor(y / cell);
  if (c < 0 || r < 0 || c >= world.fogCols || r >= world.fogRows) return false;
  if (world.fogExplored[r * world.fogCols + c]) return true;
  return isUnderLiveVision(world, x, y);
}

/** Enemy tanks/bullets — fully visible in clear; otherwise need live eyes. */
function shouldShowHostile(world: WorldState, x: number, y: number): boolean {
  if (world.shareMode === "clear") return true;
  return isUnderLiveVision(world, x, y);
}

function isUnderLiveVision(world: WorldState, x: number, y: number): boolean {
  for (const v of liveVisionViewers(world)) {
    if (dist(v.x, v.y, x, y) <= CONFIG.roles[v.role].visionRadius) return true;
  }
  return false;
}

function liveVisionViewers(world: WorldState): Tank[] {
  if (world.shareMode === "auto") {
    return world.tanks.filter((t) => t.team === "blue" && t.alive);
  }
  return world.tanks.filter(
    (t) => t.team === "blue" && t.alive && t.id === world.controlledId,
  );
}

function isEnemyVisible(world: WorldState, enemy: Tank): boolean {
  if (world.shareMode === "clear") return true;
  return liveVisionViewers(world).some((v) =>
    canSeeTank(v, enemy, world.walls),
  );
}
