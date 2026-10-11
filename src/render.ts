import { CONFIG, homeTerritoryBounds, isMpOnline } from "./config";
import { cardinalAngle, dist, eaglePosition } from "./arena";
import { canSeeTank } from "./fog";
import type { DeathFx, Tank, TeamId, Wall, WorldState } from "./types";

/** Online red sits on the north edge; rotate the view so that base is at the bottom. */
export function viewerHomeAtBottom(mode: WorldState["gameMode"], team: TeamId): boolean {
  return isMpOnline(mode) && team === "red";
}

/** Screen canvas pixels → world pixels. Identity unless the view is rotated 180°. */
export function screenToWorld(
  x: number,
  y: number,
  flipped: boolean,
): { x: number; y: number } {
  if (!flipped) return { x, y };
  return { x: CONFIG.canvasWidth - x, y: CONFIG.canvasHeight - y };
}

/** Screen arrows → world arrows when the map is shown rotated 180°. */
export function invertArrowKeys(keys: Iterable<string>): string[] {
  const out: string[] = [];
  for (const k of keys) {
    if (k === "arrowup") out.push("arrowdown");
    else if (k === "arrowdown") out.push("arrowup");
    else if (k === "arrowleft") out.push("arrowright");
    else if (k === "arrowright") out.push("arrowleft");
    else out.push(k);
  }
  return out;
}

/** True while world drawing is under the 180° online-red view. */
let viewFlipped = false;

export function renderWorld(
  ctx: CanvasRenderingContext2D,
  world: WorldState,
  mouseX: number,
  mouseY: number,
  viewerTeam: "blue" | "red" = "blue",
  marking = false,
): void {
  const W = CONFIG.canvasWidth;
  const H = CONFIG.canvasHeight;
  const viewerControlledId =
    viewerTeam === "red" ? world.remoteControlledId : world.controlledId;
  viewFlipped = viewerHomeAtBottom(world.gameMode, viewerTeam);

  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);

  ctx.save();
  if (viewFlipped) {
    ctx.translate(W, H);
    ctx.rotate(Math.PI);
  }

  drawFloor(ctx, W, H);
  drawHomeTint(ctx, viewerTeam);
  drawWalls(ctx, world);
  drawEagle(ctx, world);

  for (const w of world.wrecks) {
    if (!shouldShowWorldPos(world, w.x, w.y)) continue;
    drawWreck(ctx, w.x, w.y, w.label, w.marked, w.debugged, w.debugResult);
  }

  for (const t of world.tanks) {
    if (!t.alive) continue;
    const friendly = t.team === viewerTeam;
    // Gold command mark is local-only. Enemy hulls stay one shared look.
    const commanded = friendly && t.id === viewerControlledId;
    if (friendly || isEnemyVisible(world, t)) {
      drawTank(ctx, world, t, friendly, commanded);
    }
  }

  drawDeathFx(ctx, world);

  for (const p of world.projectiles) {
    if (p.team !== viewerTeam && !shouldShowHostile(world, p.x, p.y)) continue;
    drawBullet(ctx, p.x, p.y);
  }

  if (world.shareMode !== "clear") drawFog(ctx, world);
  drawFrontline(ctx, viewerTeam);
  drawMarkers(ctx, world);
  drawPlayerMark(ctx, world, viewerTeam);
  if (marking) drawMapX(ctx, mouseX, mouseY, 0.45);

  const me = world.tanks.find((t) => t.id === viewerControlledId && t.alive);
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

  ctx.restore();
  viewFlipped = false;

  // End-of-match banner only (ready gate uses the HTML overlay).
  if (
    world.outcome === "win" ||
    world.outcome === "lose" ||
    world.outcome === "draw"
  ) {
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

function drawHomeTint(ctx: CanvasRenderingContext2D, team: TeamId): void {
  const home = homeTerritoryBounds(team);
  ctx.fillStyle = CONFIG.colors.homeTint;
  ctx.fillRect(0, home.y0, CONFIG.canvasWidth, home.y1 - home.y0);
}

function drawFrontline(ctx: CanvasRenderingContext2D, team: TeamId): void {
  const home = homeTerritoryBounds(team);
  // Edge of home that faces the middle of the map.
  const y = team === "blue" ? home.y0 : home.y1;
  ctx.strokeStyle = CONFIG.colors.frontline;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(CONFIG.tileSize * 2, y);
  ctx.lineTo(CONFIG.canvasWidth - CONFIG.tileSize * 2, y);
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

function tankBodyColor(t: Tank, friendly: boolean): string {
  const isScout = t.role === "scout";
  if (!friendly) {
    return isScout ? CONFIG.colors.enemyScout : CONFIG.colors.enemyTeam;
  }
  const idx = Math.min(6, Math.max(1, t.number));
  if (isScout) {
    return CONFIG.colors.playerScoutByNumber[idx] ?? CONFIG.colors.playerScout;
  }
  return CONFIG.colors.playerTankByNumber[idx] ?? CONFIG.colors.playerTeam;
}

/** Bright gold hull with a moving specular band. */
function commandedCellColor(
  cell: number,
  col: number,
  sweep: number,
  body: string,
  tread: string,
  barrel: string,
  cabin: string,
): string {
  if (cell === 2) return tread;
  if (cell === 3) return barrel;
  const d = col - sweep;
  if (d > -0.6 && d < 1.4) return "#fff7c2";
  if (d >= 1.4 && d < 2.8) return "#ffe27a";
  return cell === 4 ? cabin : body;
}

/** Pulsing halo around the locally commanded tank. */
function drawCommandShine(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  time: number,
): void {
  const pulse = 0.5 + 0.5 * Math.sin(time * 5);
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  ctx.shadowColor = "#ffd000";
  ctx.shadowBlur = 16;
  ctx.strokeStyle = "#ffe14a";
  ctx.globalAlpha = 0.35 + 0.45 * pulse;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.56, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 0.2 + 0.3 * (1 - pulse);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.74, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawTank(
  ctx: CanvasRenderingContext2D,
  world: WorldState,
  t: Tank,
  friendly: boolean,
  commanded: boolean,
): void {
  const isScout = t.role === "scout";
  const body = commanded ? "#f0c020" : tankBodyColor(t, friendly);
  const tread = commanded ? "#8a5a10" : friendly ? "#4a3810" : "#505058";
  const cabin = commanded ? "#a87818" : friendly ? "#1a1408" : "#2a2a30";
  const barrel = commanded ? "#fff6c8" : friendly ? "#f0e8c0" : "#d0d0d8";

  const facing = cardinalAngle(t.angle);
  const scale = CONFIG.spriteScale;
  const n = TANK_PAT.length;
  const size = n * scale;
  // Specular band sweeping across the hull. Local viewer only.
  const sweep = commanded ? ((world.time * 9) % (n + 8)) - 4 : 0;

  ctx.save();
  ctx.translate(Math.round(t.x), Math.round(t.y));
  ctx.rotate(facing + Math.PI / 2); // pattern faces up; 0 rad is right in canvas

  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const cell = TANK_PAT[row]![col]!;
      if (!cell) continue;
      ctx.fillStyle = commanded
        ? commandedCellColor(cell, col, sweep, body, tread, barrel, cabin)
        : cell === 1
          ? body
          : cell === 2
            ? tread
            : cell === 3
              ? barrel
              : cabin;
      ctx.fillRect(
        col * scale - size / 2,
        row * scale - size / 2,
        scale,
        scale,
      );
    }
  }
  ctx.restore();

  if (commanded) drawCommandShine(ctx, t.x, t.y, size, world.time);

  // Labels in screen space so a 180° online view doesn't print them upside down.
  ctx.save();
  ctx.translate(t.x, t.y);
  if (viewFlipped) ctx.rotate(Math.PI);

  const label = String(t.number);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold 16px monospace";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#0a0804";
  ctx.strokeText(label, 0, 1);
  ctx.fillStyle = "#fffef0";
  ctx.fillText(label, 0, 1);

  ctx.fillStyle = isScout ? "#d8f080" : "#ffe060";
  ctx.font = "bold 10px monospace";
  ctx.textBaseline = "alphabetic";
  ctx.strokeStyle = "#0a0804";
  ctx.lineWidth = 2;
  ctx.strokeText(isScout ? "S" : "G", 15, -10);
  ctx.fillText(isScout ? "S" : "G", 15, -10);

  const pct = t.hp / t.maxHp;
  ctx.fillStyle = "#000";
  ctx.fillRect(-12, -18, 24, 3);
  ctx.fillStyle = pct > 0.35 ? "#40c040" : "#e04040";
  ctx.fillRect(-12, -18, 24 * pct, 3);

  if (friendly && t.isCodeCarrier && world.gameMode === "ctf") {
    ctx.fillStyle = CONFIG.colors.codeIcon;
    ctx.fillRect(-3, -24, 6, 4);
  }

  ctx.restore();

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

/** Blink husk twice then gone (mp-offline). Visible on even half-periods. */
function drawDeathFx(ctx: CanvasRenderingContext2D, world: WorldState): void {
  const half = CONFIG.mpOffline.deathBlinkHalfPeriodSec;
  for (const fx of world.deathFx) {
    const age = world.time - fx.startedAt;
    const phase = Math.floor(age / half);
    // Even phase = visible, odd = hidden → two full blinks
    if (phase % 2 === 1) continue;
    if (!shouldShowWorldPos(world, fx.x, fx.y)) continue;
    drawDeathHusk(ctx, fx);
  }
}

function drawDeathHusk(ctx: CanvasRenderingContext2D, fx: DeathFx): void {
  const mock: Tank = {
    id: fx.id,
    team: fx.team,
    number: fx.tankNumber,
    role: fx.role,
    x: fx.x,
    y: fx.y,
    angle: fx.angle,
    hp: 0,
    maxHp: 1,
    alive: false,
    cooldown: 0,
    goal: { kind: "idle" },
    standStillTimer: 0,
    reportProgress: 0,
    debugProgress: 0,
    debugTargetId: null,
    lastKnownPos: { x: fx.x, y: fx.y },
    isCodeCarrier: false,
    lastShotAt: -999,
  };
  const body = tankBodyColor(mock, fx.team === "blue");
  const tread = fx.team === "blue" ? "#4a3810" : "#505058";
  const facing = cardinalAngle(fx.angle);
  const scale = CONFIG.spriteScale;
  const n = TANK_PAT.length;
  const size = n * scale;

  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.translate(Math.round(fx.x), Math.round(fx.y));
  ctx.rotate(facing + Math.PI / 2);
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const cell = TANK_PAT[row]![col]!;
      if (!cell) continue;
      ctx.fillStyle = cell === 2 ? tread : body;
      ctx.fillRect(
        col * scale - size / 2,
        row * scale - size / 2,
        scale,
        scale,
      );
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;
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
  fillUpright(ctx, label, x, y + 4);
  if (debugged) {
    ctx.fillStyle = result === "code" ? CONFIG.colors.codeIcon : "#999";
    ctx.font = "9px monospace";
    fillUpright(ctx, result === "code" ? "CODE" : "clean", x, y + 18);
  }
  ctx.textAlign = "left";
}

function fillUpright(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
): void {
  if (!viewFlipped) {
    ctx.fillText(text, x, y);
    return;
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.PI);
  ctx.fillText(text, 0, 0);
  ctx.restore();
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

function drawMapX(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  alpha = 1,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = CONFIG.colors.marker;
  ctx.lineWidth = 3;
  const s = 11;
  ctx.beginPath();
  ctx.moveTo(x - s, y - s);
  ctx.lineTo(x + s, y + s);
  ctx.moveTo(x + s, y - s);
  ctx.lineTo(x - s, y + s);
  ctx.stroke();
  ctx.restore();
}

function drawPlayerMark(
  ctx: CanvasRenderingContext2D,
  world: WorldState,
  viewerTeam: TeamId,
): void {
  const mark = world.playerMarks[viewerTeam];
  if (!mark) return;
  drawMapX(ctx, mark.x, mark.y);
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
    fillUpright(ctx, `${m.label} ${age.toFixed(0)}s`, m.x, m.y - 16);
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
