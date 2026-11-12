import { CONFIG, homeTerritoryBounds, isMpOnline, isMpRules, type Role } from "./config";
import { cardinalAngle, dist, eaglePosition } from "./arena";
import { beliefFor } from "./belief";
import {
  applyCamera,
  minimapRect,
  visibleRect,
  worldToMinimap,
  type Camera,
} from "./camera";
import { canSeeTank } from "./fog";
import { goalState } from "./interrupt-stack";
import type { MapRoute, MapRouteRole } from "./mapgen";
import type { BaseState, DeathFx, Tank, TeamId, Wall, WorldState } from "./types";

/** Online red sits on the north edge; rotate the view so that base is at the bottom. */
export function viewerHomeAtBottom(mode: WorldState["gameMode"], team: TeamId): boolean {
  return isMpOnline(mode) && team === "red";
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

/** World-space rect currently drawn; off-screen tiles and walls are skipped. */
let view = { x0: 0, y0: 0, x1: 0, y1: 0 };

function inView(x: number, y: number, w: number, h: number): boolean {
  return x + w >= view.x0 && x <= view.x1 && y + h >= view.y0 && y <= view.y1;
}

/** `mouseX, mouseY` are world coordinates (already through the camera). */
export function renderWorld(
  ctx: CanvasRenderingContext2D,
  world: WorldState,
  cam: Camera,
  mouseX: number,
  mouseY: number,
  viewerTeam: "blue" | "red" = "blue",
  editing = false,
  routes: MapRoute[] | null = null,
): void {
  const VW = CONFIG.viewWidth;
  const VH = CONFIG.viewHeight;
  const viewerControlledId =
    viewerTeam === "red" ? world.remoteControlledId : world.controlledId;
  viewFlipped = cam.flipped;
  const r = visibleRect(cam);
  const slack = CONFIG.tileSize * 2;
  view = { x0: r.x0 - slack, y0: r.y0 - slack, x1: r.x1 + slack, y1: r.y1 + slack };

  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#101010";
  ctx.fillRect(0, 0, VW, VH);

  ctx.save();
  applyCamera(ctx, cam);

  drawFloor(ctx, CONFIG.canvasWidth, CONFIG.canvasHeight);
  drawHomeTint(ctx, viewerTeam);
  drawMiddleZoneFill(ctx, world);
  drawWalls(ctx, world);
  drawBases(ctx, world);
  if (!world.bases) drawEagle(ctx, world);

  for (const w of world.wrecks) {
    if (!inView(w.x - 12, w.y - 12, 24, 24)) continue;
    if (!shouldShowWorldPos(world, w.x, w.y)) continue;
    drawWreck(ctx, w.x, w.y, w.label, w.marked, w.debugged, w.debugResult);
  }

  for (const t of world.tanks) {
    if (!t.alive) continue;
    if (!inView(t.x - 30, t.y - 30, 60, 60)) continue;
    const friendly = t.team === viewerTeam;
    // Gold command mark is local-only. Enemy hulls stay one shared look.
    const commanded = friendly && t.id === viewerControlledId;
    if (friendly || isEnemyVisible(world, t)) {
      drawTank(ctx, world, t, friendly, commanded);
    }
  }

  drawDeathFx(ctx, world);

  for (const p of world.projectiles) {
    if (!inView(p.x - 2, p.y - 2, 4, 4)) continue;
    if (p.team !== viewerTeam && !shouldShowHostile(world, p.x, p.y)) continue;
    drawBullet(ctx, p.x, p.y);
  }

  if (world.shareMode !== "clear") drawFog(ctx, world);
  drawFrontline(ctx, viewerTeam);
  drawMiddleZoneRing(ctx, world);
  drawMarkers(ctx, world);
  drawPlayerMark(ctx, world, viewerTeam);

  if (editing) {
    for (const w of world.walls) {
      if (w.kind === "border" || !inView(w.x, w.y, w.w, w.h)) continue;
      ctx.strokeStyle = "rgba(255, 225, 74, 0.85)";
      ctx.lineWidth = 2;
      ctx.strokeRect(w.x + 1, w.y + 1, w.w - 2, w.h - 2);
    }
  }

  if (routes) drawRoutes(ctx, routes);

  const me = world.tanks.find((t) => t.id === viewerControlledId && t.alive);
  if (me && !editing) {
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

  if (routes) drawRouteLegend(ctx, routes);

  drawBaseHud(ctx, world, viewerTeam);

  // End-of-match banner only (ready gate uses the HTML overlay).
  if (
    world.outcome === "win" ||
    world.outcome === "lose" ||
    world.outcome === "draw"
  ) {
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(0, 0, VW, VH);
    ctx.fillStyle = CONFIG.colors.accent;
    ctx.font = "bold 40px monospace";
    ctx.textAlign = "center";
    const msg =
      world.outcome === "win"
        ? "STAGE CLEAR"
        : world.outcome === "lose"
          ? "GAME OVER"
          : "DRAW";
    ctx.fillText(msg, VW / 2, VH / 2);
    ctx.font = "14px monospace";
    ctx.fillStyle = "#ddd";
    if (world.outcomeReason) ctx.fillText(world.outcomeReason, VW / 2, VH / 2 + 27);
    ctx.fillText("PRESS RESTART", VW / 2, VH / 2 + 53);
    ctx.textAlign = "left";
  }
}

/** One colour per route role, so the overlay reads without the legend. */
const ROUTE_COLORS: Record<MapRouteRole, string> = {
  direct: "#f2b632",
  protected: "#4cc9f0",
  zone: "#b04ce0",
};

/** The generator's three routes, drawn in world space over the finished map. */
function drawRoutes(ctx: CanvasRenderingContext2D, routes: MapRoute[]): void {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const route of routes) {
    ctx.strokeStyle = ROUTE_COLORS[route.role];
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 4;
    ctx.beginPath();
    for (const [i, p] of route.points.entries()) {
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    // The blue-base end gets a ring, so the direction of travel is obvious.
    const from = route.points[0];
    if (!from) continue;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(from.x, from.y, CONFIG.tileSize * 0.7, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** Screen-space numbers behind each line: how long it is and how open. */
function drawRouteLegend(ctx: CanvasRenderingContext2D, routes: MapRoute[]): void {
  ctx.save();
  const x = 12;
  const lineHeight = 17;
  ctx.fillStyle = "rgba(0,0,0,0.72)";
  ctx.fillRect(x - 6, 54, 268, routes.length * lineHeight + 10);
  ctx.font = "bold 12px monospace";
  ctx.textAlign = "left";
  for (const [i, route] of routes.entries()) {
    const y = 68 + i * lineHeight;
    ctx.fillStyle = ROUTE_COLORS[route.role];
    ctx.fillRect(x, y - 8, 10, 10);
    ctx.fillStyle = "#f2f2f2";
    const viaZone = route.throughZone ? " via zone" : "";
    ctx.fillText(
      `${route.role}${viaZone}  ${Math.round(route.travelSec)}s  ` +
        `${Math.round(route.lengthPx / CONFIG.tileSize)} tiles  ` +
        `${Math.round(route.exposedShare * 100)}% open`,
      x + 16,
      y,
    );
  }
  ctx.restore();
}

function drawBaseHud(ctx: CanvasRenderingContext2D, world: WorldState, viewerTeam: TeamId): void {
  if (!world.bases) return;
  ctx.save();
  const width = 190;
  for (const [i, team] of (["blue", "red"] as const).entries()) {
    const base = world.bases[team];
    const x = CONFIG.viewWidth / 2 + (i === 0 ? -width - 12 : 12);
    ctx.fillStyle = "rgba(0,0,0,0.85)";
    ctx.fillRect(x - 8, 10, width + 16, 48);
    ctx.textAlign = "left";
    ctx.font = "bold 12px monospace";
    ctx.fillStyle = "#fff";
    ctx.fillText(`${team.toUpperCase()} BASE  ${Math.ceil(base.hp)}/${base.maxHp}`, x, 28);
    ctx.fillStyle = "#333";
    ctx.fillRect(x, 36, width, 12);
    ctx.fillStyle = team === "blue" ? "#e8c040" : "#ec5555";
    ctx.fillRect(x, 36, width * base.hp / base.maxHp, 12);
  }
  const age = world.time - world.bases[viewerTeam].lastAlertAt;
  if (age >= 0 && age < 2) {
    ctx.textAlign = "center";
    ctx.font = "bold 20px monospace";
    ctx.fillStyle = "rgba(30,0,0,0.9)";
    ctx.fillRect(CONFIG.viewWidth / 2 - 145, 66, 290, 34);
    ctx.fillStyle = "#ff7777";
    ctx.fillText("Base under attack!", CONFIG.viewWidth / 2, 90);
    if (age < 0.5) {
      ctx.strokeStyle = `rgba(255,30,30,${0.8 * (1 - age / 0.5)})`;
      ctx.lineWidth = 18;
      ctx.strokeRect(9, 9, CONFIG.viewWidth - 18, CONFIG.viewHeight - 18);
    }
  }
  ctx.restore();
}

/** Wall outline is static per layout; rebuilt only when the wall array changes. */
let minimapCache: { walls: Wall[]; w: number; h: number; img: HTMLCanvasElement } | null = null;

function minimapWalls(world: WorldState): HTMLCanvasElement | null {
  const r = minimapRect();
  if (
    minimapCache &&
    minimapCache.walls === world.walls &&
    minimapCache.w === r.w &&
    minimapCache.h === r.h
  ) {
    return minimapCache.img;
  }
  if (typeof document === "undefined") return null;
  const img = document.createElement("canvas");
  img.width = r.w;
  img.height = r.h;
  const c = img.getContext("2d")!;
  c.fillStyle = "rgba(20,20,20,0.9)";
  c.fillRect(0, 0, r.w, r.h);
  for (const w of world.walls) {
    c.fillStyle = w.kind === "border" ? "#8a8a90" : w.kind === "steel" ? "#c0c0c8" : "#b05028";
    c.fillRect(w.x * r.scale, w.y * r.scale, Math.max(1, w.w * r.scale), Math.max(1, w.h * r.scale));
  }
  minimapCache = { walls: world.walls, w: r.w, h: r.h, img };
  return img;
}

/** One hull's panel chip, in panel px: big enough for a digit, small enough
 *  that a full company still reads as dots rather than a wall of text. */
const MINIMAP_CHIP = 9;

/**
 * Full-map overview drawn on the sidebar panel: walls, friendly hulls, the
 * team's mark, and enemies only where the viewer could know about them
 * (clear mode, live sight, or belief). Every hull carries its number, friend
 * and foe alike, because the panel is where a mark gets pinned.
 * `markAt` is the cursor in panel pixels, shown as a ghost pin while F is held.
 */
export function renderMinimap(
  ctx: CanvasRenderingContext2D,
  world: WorldState,
  cam: Camera,
  viewerTeam: TeamId,
  markAt: { x: number; y: number } | null = null,
): void {
  const r = minimapRect();
  ctx.imageSmoothingEnabled = false;
  ctx.save();
  if (cam.flipped) {
    ctx.translate(r.w, r.h);
    ctx.rotate(Math.PI);
  }
  const img = minimapWalls(world);
  if (img) ctx.drawImage(img, 0, 0);
  else {
    ctx.fillStyle = "rgba(20,20,20,0.9)";
    ctx.fillRect(0, 0, r.w, r.h);
  }
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = "rgba(240,208,48,0.7)";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, r.w - 1, r.h - 1);
  ctx.restore();

  // The middle zone ring, so the zoomed-out view reads who owns the bonus.
  const zone = world.middleZone;
  const zc = worldToMinimap(cam, zone.x, zone.y);
  ctx.save();
  ctx.strokeStyle = zonePalette(world).stroke;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(zc.x, zc.y, Math.max(3, zone.radius * r.scale), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  const dot = (wx: number, wy: number, color: string, size = 3) => {
    const p = worldToMinimap(cam, wx, wy);
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(p.x - size / 2), Math.round(p.y - size / 2), size, size);
  };

  /**
   * A hull as its panel chip: a dark plate, a border in its team colour and the
   * hull's own number in that same colour. The panel is where a mark gets
   * pinned, so every hull a viewer may order has to read as one number there.
   */
  const chip = (
    wx: number,
    wy: number,
    color: string,
    num: number,
    alpha = 1,
  ) => {
    const p = worldToMinimap(cam, wx, wy);
    const x = Math.round(p.x - MINIMAP_CHIP / 2);
    const y = Math.round(p.y - MINIMAP_CHIP / 2);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "rgba(8,8,8,0.78)";
    ctx.fillRect(x, y, MINIMAP_CHIP, MINIMAP_CHIP);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, MINIMAP_CHIP - 1, MINIMAP_CHIP - 1);
    ctx.fillStyle = color;
    ctx.font = "bold 8px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(num), x + MINIMAP_CHIP / 2, y + MINIMAP_CHIP / 2 + 0.5);
    ctx.restore();
  };

  const viewerControlledId =
    viewerTeam === "red" ? world.remoteControlledId : world.controlledId;
  const belief = beliefFor(world, viewerTeam);
  const now = world.time;
  for (const t of world.tanks) {
    if (!t.alive) continue;
    if (t.team === viewerTeam) {
      chip(t.x, t.y, t.id === viewerControlledId ? "#fff0a0" : "#e0b020", t.number);
      continue;
    }
    if (world.shareMode === "clear" || isEnemyVisible(world, t)) {
      chip(t.x, t.y, "#e04040", t.number);
      continue;
    }
    const c = belief.contacts.find((k) => k.enemyId === t.id);
    if (c && now - c.seenAt <= CONFIG.ai.beliefTtlSec) {
      if (c.observed) chip(c.x, c.y, "rgba(224,64,64,0.62)", c.observed.number, 0.62);
      else dot(c.x, c.y, "rgba(224,64,64,0.55)", 3);
    }
  }

  const mark = world.playerMarks[viewerTeam];
  if (mark) {
    const p = worldToMinimap(cam, mark.x, mark.y);
    ctx.strokeStyle = CONFIG.colors.marker;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(p.x - 3, p.y - 3);
    ctx.lineTo(p.x + 3, p.y + 3);
    ctx.moveTo(p.x + 3, p.y - 3);
    ctx.lineTo(p.x - 3, p.y + 3);
    ctx.stroke();
  }

  // The ghost pin: a mark goes down where the cursor crosses this panel, nowhere else.
  if (markAt) {
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = CONFIG.colors.marker;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(markAt.x - 4, markAt.y - 4);
    ctx.lineTo(markAt.x + 4, markAt.y + 4);
    ctx.moveTo(markAt.x + 4, markAt.y - 4);
    ctx.lineTo(markAt.x - 4, markAt.y + 4);
    ctx.stroke();
    ctx.restore();
  }

  const v = visibleRect(cam);
  const a = worldToMinimap(cam, v.x0, v.y0);
  const b = worldToMinimap(cam, v.x1, v.y1);
  ctx.strokeStyle = "rgba(255,255,255,0.6)";
  ctx.lineWidth = 1;
  ctx.strokeRect(
    Math.min(a.x, b.x) + 0.5,
    Math.min(a.y, b.y) + 0.5,
    Math.abs(b.x - a.x),
    Math.abs(b.y - a.y),
  );
}

function drawFloor(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  ctx.fillStyle = CONFIG.colors.floor;
  ctx.fillRect(0, 0, W, H);
  const s = CONFIG.tileSize;
  const y0 = Math.max(0, Math.floor(view.y0 / s) * s);
  const y1 = Math.min(H, view.y1);
  const x0 = Math.max(0, Math.floor(view.x0 / s) * s);
  const x1 = Math.min(W, view.x1);
  for (let y = y0; y < y1; y += s) {
    for (let x = x0; x < x1; x += s) {
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

/**
 * Which of the four middle-zone palettes is in force. Outside the multiplayer
 * ruleset nothing respawns, so the zone never has a holder to advertise — it
 * draws open.
 */
function zonePalette(world: WorldState): { stroke: string; fill: string } {
  const live = isMpRules(world.gameMode);
  const holder = live ? world.middleZone.holder : null;
  if (holder === "blue") {
    return { stroke: CONFIG.colors.zoneBlue, fill: CONFIG.colors.zoneFillBlue };
  }
  if (holder === "red") {
    return { stroke: CONFIG.colors.zoneRed, fill: CONFIG.colors.zoneFillRed };
  }
  if (live && world.middleZone.contested) {
    return { stroke: CONFIG.colors.zoneContested, fill: CONFIG.colors.zoneFillContested };
  }
  return { stroke: CONFIG.colors.zoneOpen, fill: CONFIG.colors.zoneFillOpen };
}

/** The zone's ground wash, drawn with the home tint so walls and hulls stay over it. */
function drawMiddleZoneFill(ctx: CanvasRenderingContext2D, world: WorldState): void {
  const zone = world.middleZone;
  const d = zone.radius * 2;
  if (!inView(zone.x - zone.radius, zone.y - zone.radius, d, d)) return;
  ctx.fillStyle = zonePalette(world).fill;
  ctx.beginPath();
  ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * The zone's boundary, drawn after the fog like the frontline: who holds the
 * respawn bonus is information both teams already have, so it stays readable
 * over brick and stone.
 */
function drawMiddleZoneRing(ctx: CanvasRenderingContext2D, world: WorldState): void {
  const zone = world.middleZone;
  const d = zone.radius * 2;
  if (!inView(zone.x - zone.radius, zone.y - zone.radius, d, d)) return;
  ctx.strokeStyle = zonePalette(world).stroke;
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 6]);
  ctx.beginPath();
  ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  // The exact middle, so the circle reads as a place to stand rather than an object.
  ctx.fillStyle = zonePalette(world).stroke;
  ctx.fillRect(zone.x - 2, zone.y - 2, 4, 4);
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
    if (w.baseTeam || !inView(w.x, w.y, w.w, w.h)) continue;
    if (w.kind === "brick") drawBrickBlock(ctx, w);
    else if (w.kind === "steel") drawSteelBlock(ctx, w);
    else drawBorderBlock(ctx, w);
  }
}

const baseDestructionStarted = new WeakMap<BaseState, number>();

function drawBases(ctx: CanvasRenderingContext2D, world: WorldState): void {
  for (const base of Object.values(world.bases ?? {})) {
    if (!inView(base.x - 50, base.y - 50, base.w + 100, base.h + 100)) continue;
    if (base.alive) drawBase(ctx, world, base);
    else if (base.destroyedAt != null) {
      const now = performance.now();
      const started = baseDestructionStarted.get(base) ?? now;
      baseDestructionStarted.set(base, started);
      // Match adjudication freezes simulation time before the explosion finishes.
      const age = Math.max(world.time - base.destroyedAt, (now - started) / 1000);
      if (age <= CONFIG.baseDestructionSec) drawBaseDestruction(ctx, base, age);
    }
  }
}

function drawBase(ctx: CanvasRenderingContext2D, world: WorldState, base: BaseState): void {
  const blue = base.team === "blue";
  ctx.fillStyle = blue ? "#8a6810" : "#873834";
  ctx.fillRect(base.x, base.y, base.w, base.h);
  ctx.fillStyle = blue ? "#d5aa2c" : "#c45a50";
  for (let i = 0; i < 3; i++) {
    ctx.fillRect(base.x + i * 16 + 2, base.y + 2, 12, 4);
    ctx.fillRect(base.x + 2, base.y + i * 16 + 2, 4, 12);
  }
  ctx.fillStyle = "#202028";
  ctx.fillRect(base.x + 9, base.y + 9, 30, 30);
  ctx.fillStyle = blue ? "#f0d060" : "#e87868";
  const cx = base.x + base.w / 2;
  const cy = base.y + base.h / 2;
  if (blue) {
    ctx.beginPath();
    ctx.moveTo(cx, cy - 12);
    ctx.lineTo(cx + 5, cy - 3);
    ctx.lineTo(cx + 13, cy - 6);
    ctx.lineTo(cx + 8, cy + 5);
    ctx.lineTo(cx + 3, cy + 3);
    ctx.lineTo(cx, cy + 12);
    ctx.lineTo(cx - 3, cy + 3);
    ctx.lineTo(cx - 8, cy + 5);
    ctx.lineTo(cx - 13, cy - 6);
    ctx.lineTo(cx - 5, cy - 3);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const angle = -Math.PI / 2 + i * Math.PI / 5;
      const radius = i % 2 === 0 ? 13 : 5;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  }
  if (world.time - base.lastHitAt <= CONFIG.baseHitFlashSec) {
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.fillRect(base.x, base.y, base.w, base.h);
  }
  ctx.fillStyle = "#080808";
  ctx.fillRect(base.x, base.y - 9, base.w, 5);
  ctx.fillStyle = blue ? "#e5bd38" : "#d85c50";
  ctx.fillRect(base.x + 1, base.y - 8, (base.w - 2) * base.hp / base.maxHp, 3);
}

function drawBaseDestruction(ctx: CanvasRenderingContext2D, base: BaseState, age: number): void {
  const progress = Math.min(1, age / CONFIG.baseDestructionSec);
  const cx = base.x + base.w / 2;
  const cy = base.y + base.h / 2;
  ctx.save();
  ctx.globalAlpha = 1 - progress;
  for (let i = 0; i < 12; i++) {
    const angle = i * Math.PI / 6;
    const radius = 8 + progress * (24 + (i % 3) * 9);
    ctx.fillStyle = i % 2 ? "#e06028" : "#f0d060";
    ctx.beginPath();
    ctx.arc(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, 7 - progress * 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
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
  const isHeavy = t.role === "heavy";
  if (!friendly) {
    if (isScout) return CONFIG.colors.enemyScout;
    if (isHeavy) return CONFIG.colors.enemyHeavy;
    return CONFIG.colors.enemyTeam;
  }
  if (isHeavy) {
    const idx = Math.min(6, Math.max(1, t.number));
    return CONFIG.colors.playerHeavyByNumber[idx] ?? "#6a5040";
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

/** The two-letter type mark painted at the hull's corner, tinted per type. */
const TYPE_MARK_COLOR: Record<Role, string> = {
  scout: "#d8f080",
  heavy: "#ffb060",
  artillery: "#c090ff",
  engineer: "#80e0d0",
  nuke: "#ff7070",
  shooter: "#ffe060",
};

function drawTank(
  ctx: CanvasRenderingContext2D,
  world: WorldState,
  t: Tank,
  friendly: boolean,
  commanded: boolean,
): void {
  const isHeavy = t.role === "heavy";
  const body = commanded ? "#f0c020" : tankBodyColor(t, friendly);
  const tread = commanded ? "#8a5a10" : friendly ? "#4a3810" : "#505058";
  const cabin = commanded ? "#a87818" : friendly ? "#1a1408" : "#2a2a30";
  const barrel = commanded ? "#fff6c8" : friendly ? "#f0e8c0" : "#d0d0d8";

  const facing = cardinalAngle(t.angle);
  const scale = isHeavy ? CONFIG.spriteScale + 1 : CONFIG.spriteScale;
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

  const mark = CONFIG.roles[t.role].shortCode;
  ctx.fillStyle = TYPE_MARK_COLOR[t.role];
  ctx.font = "bold 10px monospace";
  ctx.textBaseline = "alphabetic";
  ctx.strokeStyle = "#0a0804";
  ctx.lineWidth = 2;
  ctx.strokeText(mark, 15, -10);
  ctx.fillText(mark, 15, -10);

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
    nukeCooldown: 0,
    ...goalState({ kind: "idle" }),
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
    const rad = CONFIG.roles[v.role].visionRange;
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

  const r0 = Math.max(0, Math.floor(view.y0 / cell));
  const r1 = Math.min(world.fogRows - 1, Math.ceil(view.y1 / cell));
  const c0 = Math.max(0, Math.floor(view.x0 / cell));
  const c1 = Math.min(world.fogCols - 1, Math.ceil(view.x1 / cell));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
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
    if (dist(v.x, v.y, x, y) <= CONFIG.roles[v.role].visionRange) return true;
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
