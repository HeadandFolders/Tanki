import { CONFIG } from "./config";

/** Follow camera. `x, y` is the world point drawn at the screen center. */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
  /** Online red sees the map rotated 180°, so screen axes point the other way. */
  flipped: boolean;
}

export function createCamera(flipped = false): Camera {
  return {
    x: CONFIG.canvasWidth / 2,
    y: CONFIG.canvasHeight / 2,
    zoom: CONFIG.camera.zoomDefault,
    flipped,
  };
}

/** Half of the world extent that fits on screen at the current zoom. */
function halfView(cam: Camera): { hw: number; hh: number } {
  return {
    hw: CONFIG.viewWidth / 2 / cam.zoom,
    hh: CONFIG.viewHeight / 2 / cam.zoom,
  };
}

/** Keep the view inside the arena; a view wider than the arena centers it. */
export function clampCamera(cam: Camera): void {
  const { hw, hh } = halfView(cam);
  const W = CONFIG.canvasWidth;
  const H = CONFIG.canvasHeight;
  cam.x = hw * 2 >= W ? W / 2 : Math.min(W - hw, Math.max(hw, cam.x));
  cam.y = hh * 2 >= H ? H / 2 : Math.min(H - hh, Math.max(hh, cam.y));
}

export function snapCamera(cam: Camera, x: number, y: number): void {
  cam.x = x;
  cam.y = y;
  clampCamera(cam);
}

/** Exponential ease toward the target, frame-rate independent. */
export function followCamera(cam: Camera, tx: number, ty: number, dt: number): void {
  const k = 1 - Math.exp(-CONFIG.camera.followRate * dt);
  cam.x += (tx - cam.x) * k;
  cam.y += (ty - cam.y) * k;
  clampCamera(cam);
}

export function zoomCamera(cam: Camera, notches: number): void {
  const z = cam.zoom * Math.pow(CONFIG.camera.zoomStep, -notches);
  cam.zoom = Math.min(CONFIG.camera.zoomMax, Math.max(CONFIG.camera.zoomMin, z));
  clampCamera(cam);
}

/** Canvas pixel → world point through the same transform renderWorld applies. */
export function screenToWorld(
  cam: Camera,
  sx: number,
  sy: number,
): { x: number; y: number } {
  const s = cam.flipped ? -1 : 1;
  return {
    x: cam.x + (s * (sx - CONFIG.viewWidth / 2)) / cam.zoom,
    y: cam.y + (s * (sy - CONFIG.viewHeight / 2)) / cam.zoom,
  };
}

export function worldToScreen(
  cam: Camera,
  wx: number,
  wy: number,
): { x: number; y: number } {
  const s = cam.flipped ? -1 : 1;
  return {
    x: CONFIG.viewWidth / 2 + s * (wx - cam.x) * cam.zoom,
    y: CONFIG.viewHeight / 2 + s * (wy - cam.y) * cam.zoom,
  };
}

/** World rectangle currently on screen (axis-aligned; the flip keeps it so). */
export function visibleRect(cam: Camera): {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
} {
  const { hw, hh } = halfView(cam);
  return { x0: cam.x - hw, y0: cam.y - hh, x1: cam.x + hw, y1: cam.y + hh };
}

/** Apply the camera to a 2D context: screen center → flip → zoom → world. */
export function applyCamera(ctx: CanvasRenderingContext2D, cam: Camera): void {
  ctx.translate(CONFIG.viewWidth / 2, CONFIG.viewHeight / 2);
  if (cam.flipped) ctx.rotate(Math.PI);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);
}

/**
 * Minimap surface in its own canvas px; the arena fills it edge to edge, so
 * the box origin is always (0, 0) and the panel element is the frame.
 */
export function minimapRect(): { w: number; h: number; scale: number } {
  const w = CONFIG.camera.minimapWidth;
  const scale = w / CONFIG.canvasWidth;
  return { w, h: Math.round(CONFIG.canvasHeight * scale), scale };
}

/** Minimap pixel → world point, honoring the flip; null when it misses the map. */
export function minimapToWorld(
  cam: Camera,
  sx: number,
  sy: number,
): { x: number; y: number } | null {
  const r = minimapRect();
  if (sx < 0 || sy < 0 || sx > r.w || sy > r.h) return null;
  let x = sx / r.scale;
  let y = sy / r.scale;
  if (cam.flipped) {
    x = CONFIG.canvasWidth - x;
    y = CONFIG.canvasHeight - y;
  }
  return { x, y };
}

export function worldToMinimap(
  cam: Camera,
  wx: number,
  wy: number,
): { x: number; y: number } {
  const r = minimapRect();
  const x = cam.flipped ? CONFIG.canvasWidth - wx : wx;
  const y = cam.flipped ? CONFIG.canvasHeight - wy : wy;
  return { x: x * r.scale, y: y * r.scale };
}
