import { CONFIG, homeTerritoryBounds } from "./config";
import { dist } from "./arena";
import { canSeeTank } from "./fog";
import type { Tank, WorldState } from "./types";

export function renderWorld(
  ctx: CanvasRenderingContext2D,
  world: WorldState,
  mouseX: number,
  mouseY: number,
): void {
  const W = CONFIG.canvasWidth;
  const H = CONFIG.canvasHeight;

  ctx.clearRect(0, 0, W, H);
  drawMapBase(ctx, W, H);
  drawHomeTerritory(ctx, world);
  drawWalls(ctx, world);
  drawMapOverlays(ctx, world);

  for (const w of world.wrecks) {
    if (!shouldShowWorldPos(world, w.x, w.y)) continue;
    drawWreck(ctx, w.x, w.y, w.label, w.marked, w.debugged, w.debugResult);
  }

  for (const t of world.tanks) {
    if (!t.alive) continue;
    if (t.team === "blue") {
      drawTank(ctx, world, t, true);
    } else if (isEnemyLiveVisible(world, t)) {
      drawTank(ctx, world, t, false);
    }
  }

  for (const p of world.projectiles) {
    if (!shouldShowWorldPos(world, p.x, p.y) && p.team === "red") continue;
    ctx.beginPath();
    ctx.fillStyle = p.team === "blue" ? "#b8d4ff" : "#ffb0b0";
    ctx.arc(p.x, p.y, CONFIG.bulletRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  drawFog(ctx, world);
  drawFrontline(ctx, world);
  drawMarkers(ctx, world);
  drawMapChrome(ctx, world);

  const me = world.tanks.find((t) => t.id === world.controlledId && t.alive);
  if (me) {
    ctx.strokeStyle = "rgba(200,220,255,0.35)";
    ctx.beginPath();
    ctx.moveTo(me.x, me.y);
    ctx.lineTo(mouseX, mouseY);
    ctx.stroke();
  }

  if (world.outcome !== "playing") {
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 42px IBM Plex Sans, sans-serif";
    ctx.textAlign = "center";
    const msg =
      world.outcome === "win"
        ? "VICTORY"
        : world.outcome === "lose"
          ? "DEFEAT"
          : "DRAW";
    ctx.fillText(msg, W / 2, H / 2);
    ctx.font = "16px IBM Plex Sans, sans-serif";
    ctx.fillStyle = "#c9d4e6";
    ctx.fillText("Press Restart for another match", W / 2, H / 2 + 36);
    ctx.textAlign = "left";
  }
}

function drawMapBase(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
): void {
  ctx.fillStyle = CONFIG.colors.floor;
  ctx.fillRect(0, 0, W, H);

  // Checker-ish topo blocks for map texture
  const step = CONFIG.fog.gridStep;
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      if (((x / step) + (y / step)) % 2 === 0) {
        ctx.fillStyle = CONFIG.colors.floorAlt;
        ctx.fillRect(x, y, step, step);
      }
    }
  }

  // Grid
  ctx.strokeStyle = CONFIG.colors.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= W; x += step) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, H);
  }
  for (let y = 0; y <= H; y += step) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(W, y + 0.5);
  }
  ctx.stroke();
}

function drawHomeTerritory(
  ctx: CanvasRenderingContext2D,
  _world: WorldState,
): void {
  const home = homeTerritoryBounds("blue");
  const W = CONFIG.canvasWidth;
  ctx.fillStyle = CONFIG.colors.homeTint;
  ctx.fillRect(0, home.y0, W, home.y1 - home.y0);
}

function drawFrontline(
  ctx: CanvasRenderingContext2D,
  world: WorldState,
): void {
  const home = homeTerritoryBounds("blue");
  const W = CONFIG.canvasWidth;
  // Only draw where the strip edge is known (home is always explored)
  ctx.save();
  ctx.strokeStyle = CONFIG.colors.frontline;
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.moveTo(0, home.y0);
  ctx.lineTo(W, home.y0);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = CONFIG.colors.accent;
  ctx.font = "bold 11px monospace";
  ctx.textAlign = "left";
  if (world.fogExplored[Math.floor(home.y0 / CONFIG.fog.cellSize) * world.fogCols]) {
    ctx.fillText("FRONT · FRIENDLY SOUTH", 10, home.y0 - 6);
  }
  ctx.restore();
}

function drawMapOverlays(
  ctx: CanvasRenderingContext2D,
  world: WorldState,
): void {
  // Soft labels for landmarks when explored
  const labels = [
    { x: CONFIG.canvasWidth * 0.5, y: CONFIG.canvasHeight * 0.45, text: "CHOKE" },
    { x: CONFIG.canvasWidth * 0.25, y: CONFIG.canvasHeight * 0.28, text: "BUNKER" },
    { x: CONFIG.canvasWidth * 0.75, y: CONFIG.canvasHeight * 0.7, text: "LANE" },
  ];
  ctx.font = "10px monospace";
  ctx.textAlign = "center";
  for (const l of labels) {
    if (!shouldShowWorldPos(world, l.x, l.y)) continue;
    ctx.fillStyle = "rgba(210, 220, 230, 0.45)";
    ctx.fillText(l.text, l.x, l.y);
  }
  ctx.textAlign = "left";
}

function drawMapChrome(
  ctx: CanvasRenderingContext2D,
  world: WorldState,
): void {
  const W = CONFIG.canvasWidth;
  const H = CONFIG.canvasHeight;
  const step = CONFIG.fog.gridStep;

  ctx.fillStyle = "rgba(220, 230, 240, 0.55)";
  ctx.font = "10px monospace";
  ctx.textAlign = "center";
  // Column letters along bottom of home (always visible there)
  const letters = "ABCDEFGHIJKLMNOPQRST";
  for (let i = 0; i * step < W; i++) {
    const x = i * step + step / 2;
    const y = H - 8;
    if (shouldShowWorldPos(world, x, y)) {
      ctx.fillText(letters[i % letters.length] ?? String(i), x, y);
    }
  }
  ctx.textAlign = "right";
  for (let i = 0; i * step < H; i++) {
    const y = i * step + step / 2;
    if (shouldShowWorldPos(world, 18, y)) {
      ctx.fillText(String(i + 1), 18, y + 3);
    }
  }
  ctx.textAlign = "left";

  // Compass
  ctx.fillStyle = CONFIG.colors.accent;
  ctx.font = "bold 12px monospace";
  ctx.fillText("N", W / 2 - 4, 16);
  ctx.fillStyle = "rgba(200,210,220,0.5)";
  ctx.font = "10px monospace";
  ctx.fillText("S HOME", W / 2 - 18, H - 20);
}

function shouldShowWorldPos(world: WorldState, x: number, y: number): boolean {
  const cell = CONFIG.fog.cellSize;
  const c = Math.floor(x / cell);
  const r = Math.floor(y / cell);
  if (c < 0 || r < 0 || c >= world.fogCols || r >= world.fogRows) return false;
  if (world.fogExplored[r * world.fogCols + c]) return true;
  return isUnderLiveVision(world, x, y);
}

function isUnderLiveVision(world: WorldState, x: number, y: number): boolean {
  const viewers =
    world.shareMode === "auto"
      ? world.tanks.filter((t) => t.team === "blue" && t.alive)
      : world.tanks.filter(
          (t) => t.team === "blue" && t.alive && t.id === world.controlledId,
        );
  for (const v of viewers) {
    const rad = CONFIG.roles[v.role].visionRadius;
    if (dist(v.x, v.y, x, y) <= rad) return true;
  }
  return false;
}

function isEnemyLiveVisible(world: WorldState, enemy: Tank): boolean {
  const viewers =
    world.shareMode === "auto"
      ? world.tanks.filter((t) => t.team === "blue" && t.alive)
      : world.tanks.filter(
          (t) => t.team === "blue" && t.alive && t.id === world.controlledId,
        );
  return viewers.some((v) => canSeeTank(v, enemy, world.walls));
}

function drawWalls(ctx: CanvasRenderingContext2D, world: WorldState): void {
  for (const w of world.walls) {
    ctx.fillStyle = CONFIG.colors.wall;
    ctx.fillRect(w.x, w.y, w.w, w.h);
    ctx.strokeStyle = CONFIG.colors.wallStroke;
    ctx.lineWidth = 1;
    ctx.strokeRect(w.x + 0.5, w.y + 0.5, w.w - 1, w.h - 1);
  }
}

function drawFog(ctx: CanvasRenderingContext2D, world: WorldState): void {
  const cell = CONFIG.fog.cellSize;
  const live = new Set<number>();
  const viewers =
    world.shareMode === "auto"
      ? world.tanks.filter((t) => t.team === "blue" && t.alive)
      : world.tanks.filter(
          (t) => t.team === "blue" && t.alive && t.id === world.controlledId,
        );

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
        const dx = cx - v.x;
        const dy = cy - v.y;
        if (dx * dx + dy * dy <= r2) live.add(r * world.fogCols + c);
      }
    }
  }

  for (let r = 0; r < world.fogRows; r++) {
    for (let c = 0; c < world.fogCols; c++) {
      const i = r * world.fogCols + c;
      if (live.has(i)) continue;
      const explored = world.fogExplored[i] === 1;
      ctx.fillStyle = explored
        ? `rgba(5,8,14,${CONFIG.fog.exploredAlpha})`
        : `rgba(2,4,8,${CONFIG.fog.hiddenAlpha})`;
      ctx.fillRect(c * cell, r * cell, cell + 0.5, cell + 0.5);
    }
  }

  for (const v of viewers) {
    const rad = CONFIG.roles[v.role].visionRadius;
    const g = ctx.createRadialGradient(v.x, v.y, 8, v.x, v.y, rad);
    g.addColorStop(0, CONFIG.colors.vision);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(v.x, v.y, rad, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawTank(
  ctx: CanvasRenderingContext2D,
  world: WorldState,
  t: Tank,
  friendly: boolean,
): void {
  const color = friendly ? CONFIG.colors.playerTeam : CONFIG.colors.enemyTeam;
  const r = CONFIG.tankRadius;
  const isScout = t.role === "scout";

  // Soft vision hint for friendlies (larger ring = scout)
  if (friendly) {
    const rad = CONFIG.roles[t.role].visionRadius;
    ctx.strokeStyle = isScout
      ? "rgba(154, 215, 255, 0.22)"
      : "rgba(255, 211, 154, 0.14)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(t.x, t.y, Math.min(rad, 70), 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.rotate(t.angle);

  ctx.fillStyle = color;
  ctx.strokeStyle = isScout ? "#9ad7ff" : "#ffd39a";
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (isScout) {
    // Diamond hull = scout
    ctx.moveTo(0, -r);
    ctx.lineTo(r * 0.9, 0);
    ctx.lineTo(0, r);
    ctx.lineTo(-r * 0.9, 0);
    ctx.closePath();
  } else {
    // Box hull = shooter
    ctx.roundRect(-r, -r * 0.75, r * 2, r * 1.5, 3);
  }
  ctx.fill();
  ctx.stroke();

  if (!isScout) {
    ctx.fillStyle = "#d7dee8";
    ctx.fillRect(0, -3, r + 10, 6);
  } else {
    // Sensor mast
    ctx.strokeStyle = "#d7dee8";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(r + 6, 0);
    ctx.stroke();
  }

  ctx.restore();

  ctx.fillStyle = "#fff";
  ctx.font = "bold 11px monospace";
  ctx.textAlign = "center";
  ctx.fillText(String(t.number), t.x, t.y + 4);

  // Role letter badge
  ctx.fillStyle = isScout ? "#9ad7ff" : "#ffd39a";
  ctx.font = "bold 9px monospace";
  ctx.fillText(isScout ? "S" : "G", t.x + r + 6, t.y - 2);

  const pct = t.hp / t.maxHp;
  ctx.fillStyle = "#222";
  ctx.fillRect(t.x - 14, t.y - r - 10, 28, 4);
  ctx.fillStyle = pct > 0.35 ? "#6dca7a" : "#e35d5d";
  ctx.fillRect(t.x - 14, t.y - r - 10, 28 * pct, 4);

  if (friendly && t.isCodeCarrier) {
    ctx.fillStyle = CONFIG.colors.codeIcon;
    ctx.beginPath();
    ctx.moveTo(t.x, t.y - r - 20);
    ctx.lineTo(t.x + 5, t.y - r - 12);
    ctx.lineTo(t.x - 5, t.y - r - 12);
    ctx.closePath();
    ctx.fill();
  }

  if (t.id === world.controlledId) {
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(t.x, t.y, r + 6, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (t.debugProgress > 0) {
    ctx.strokeStyle = CONFIG.colors.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(
      t.x,
      t.y,
      r + 10,
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
  ctx.fillStyle = CONFIG.colors.wreck;
  ctx.beginPath();
  ctx.arc(x, y, CONFIG.tankRadius * 0.85, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = marked ? CONFIG.colors.marker : "#2a2418";
  ctx.lineWidth = marked ? 3 : 1;
  ctx.stroke();
  ctx.fillStyle = "#f2e6c8";
  ctx.font = "bold 12px monospace";
  ctx.textAlign = "center";
  ctx.fillText(label, x, y + 4);
  if (debugged) {
    ctx.fillStyle = result === "code" ? CONFIG.colors.codeIcon : "#9aa";
    ctx.font = "10px sans-serif";
    ctx.fillText(
      result === "code" ? "CODE" : "clean",
      x,
      y + CONFIG.tankRadius + 12,
    );
  }
  ctx.textAlign = "left";
}

function drawMarkers(ctx: CanvasRenderingContext2D, world: WorldState): void {
  for (const m of world.markers) {
    const age = world.time - m.createdAt;
    const fade = 1 - age / CONFIG.markerFadeSeconds;
    if (fade <= 0) continue;
    ctx.globalAlpha = Math.max(0.15, fade);
    ctx.strokeStyle = CONFIG.colors.marker;
    ctx.fillStyle = CONFIG.colors.marker;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(m.x, m.y, 16, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    const ts = age.toFixed(0) + "s";
    ctx.fillText(`${m.label} ${ts}`, m.x, m.y - 20);
    ctx.globalAlpha = 1;
    ctx.textAlign = "left";
  }
}
