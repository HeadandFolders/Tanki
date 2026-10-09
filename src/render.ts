import { CONFIG } from "./config";
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
  ctx.fillStyle = CONFIG.colors.floor;
  ctx.fillRect(0, 0, W, H);

  // Terrain always drawn; fog overlays
  drawWalls(ctx, world);

  // Wrecks (only if explored or in live vision / marker)
  for (const w of world.wrecks) {
    if (!shouldShowWorldPos(world, w.x, w.y)) continue;
    drawWreck(ctx, w.x, w.y, w.label, w.marked, w.debugged, w.debugResult);
  }

  // Enemy tanks only if visible to vision contributors
  for (const t of world.tanks) {
    if (!t.alive) continue;
    if (t.team === "blue") {
      drawTank(ctx, world, t, true);
    } else if (isEnemyLiveVisible(world, t)) {
      drawTank(ctx, world, t, false);
    }
  }

  // Projectiles if explored-ish
  for (const p of world.projectiles) {
    if (!shouldShowWorldPos(world, p.x, p.y) && p.team === "red") continue;
    ctx.beginPath();
    ctx.fillStyle = p.team === "blue" ? "#b8d4ff" : "#ffb0b0";
    ctx.arc(p.x, p.y, CONFIG.bulletRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  drawFog(ctx, world);
  drawMarkers(ctx, world);

  // Aim line for controlled
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

function shouldShowWorldPos(world: WorldState, x: number, y: number): boolean {
  const cell = CONFIG.fog.cellSize;
  const c = Math.floor(x / cell);
  const r = Math.floor(y / cell);
  if (c < 0 || r < 0 || c >= world.fogCols || r >= world.fogRows) return false;
  if (world.fogExplored[r * world.fogCols + c]) return true;
  // live vision even if not yet written
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
  ctx.fillStyle = CONFIG.colors.wall;
  for (const w of world.walls) {
    ctx.fillRect(w.x, w.y, w.w, w.h);
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

  // soft vision tint
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
  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.rotate(t.angle);

  // body
  ctx.fillStyle = color;
  ctx.strokeStyle = "#0a0e14";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(-r, -r * 0.75, r * 2, r * 1.5, 3);
  ctx.fill();
  ctx.stroke();

  // barrel
  ctx.fillStyle = "#d7dee8";
  ctx.fillRect(0, -3, r + 10, 6);

  ctx.restore();

  // number
  ctx.fillStyle = "#fff";
  ctx.font = "bold 11px monospace";
  ctx.textAlign = "center";
  ctx.fillText(String(t.number), t.x, t.y + 4);

  // HP bar
  const pct = t.hp / t.maxHp;
  ctx.fillStyle = "#222";
  ctx.fillRect(t.x - 14, t.y - r - 10, 28, 4);
  ctx.fillStyle = pct > 0.35 ? "#6dca7a" : "#e35d5d";
  ctx.fillRect(t.x - 14, t.y - r - 10, 28 * pct, 4);

  // role tick
  ctx.fillStyle = t.role === "scout" ? "#9ad7ff" : "#ffd39a";
  ctx.fillRect(t.x - 14, t.y - r - 14, t.role === "scout" ? 10 : 6, 2);

  // own carrier icon only
  if (friendly && t.isCodeCarrier) {
    ctx.fillStyle = CONFIG.colors.codeIcon;
    ctx.beginPath();
    ctx.moveTo(t.x, t.y - r - 20);
    ctx.lineTo(t.x + 5, t.y - r - 12);
    ctx.lineTo(t.x - 5, t.y - r - 12);
    ctx.closePath();
    ctx.fill();
  }

  // controlled ring
  if (t.id === world.controlledId) {
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(t.x, t.y, r + 6, 0, Math.PI * 2);
    ctx.stroke();
  }

  // debug progress
  if (t.debugProgress > 0) {
    ctx.strokeStyle = CONFIG.colors.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(t.x, t.y, r + 10, -Math.PI / 2, -Math.PI / 2 + t.debugProgress * Math.PI * 2);
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
    ctx.fillText(result === "code" ? "CODE" : "clean", x, y + CONFIG.tankRadius + 12);
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
