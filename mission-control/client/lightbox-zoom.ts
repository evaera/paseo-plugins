/**
 * The lightbox's zoom and pan, and what a tap or a key does in it. Pure, so the rules are testable
 * without a renderer; `./lightbox` draws them.
 *
 * A `Transform`'s `scale` is screen points per image pixel, so 1 is the image at its real size, and
 * `x`, `y` are how far the image's centre sits from the viewport's centre.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Transform {
  scale: number;
  x: number;
  y: number;
}

/** What a transform is clamped against: the image's real size, the viewport, and the margin fit keeps. */
export interface Geometry {
  image: Size;
  viewport: Size;
  margin: number;
}

/** How far past its real size an image zooms. */
export const MAX_ZOOM = 5;
/** Two scales closer than this are the same stop, so a float's drift never reads as "zoomed". */
const SAME_SCALE = 0.001;

/** The margin fit keeps around the image: slim where the window is, so a phone's image is not a stamp. */
export function fitMargin(viewport: Size): number {
  return Math.min(viewport.width, viewport.height) < 600 ? 12 : 40;
}

/** The scale that shows the whole image inside the margin, never above 1: a small image is not blown up. */
export function fitScale(geometry: Geometry): number {
  const { image, viewport, margin } = geometry;
  if (image.width <= 0 || image.height <= 0) return 1;
  const width = Math.max(1, viewport.width - margin * 2);
  const height = Math.max(1, viewport.height - margin * 2);
  return Math.min(1, width / image.width, height / image.height);
}

export function scaleLimits(geometry: Geometry): { min: number; max: number } {
  return { min: fitScale(geometry), max: MAX_ZOOM };
}

export function fitTransform(geometry: Geometry): Transform {
  return { scale: fitScale(geometry), x: 0, y: 0 };
}

export function isAtFit(transform: Transform, geometry: Geometry): boolean {
  return Math.abs(transform.scale - fitScale(geometry)) < SAME_SCALE;
}

function clampOffset(offset: number, scaled: number, viewport: number): number {
  // An axis the image does not fill stays centred; one it overflows stops with its edge at the viewport's.
  const reach = Math.max(0, (scaled - viewport) / 2);
  return Math.min(reach, Math.max(-reach, offset));
}

export function clampTransform(transform: Transform, geometry: Geometry): Transform {
  const { min, max } = scaleLimits(geometry);
  const scale = Math.min(max, Math.max(min, transform.scale));
  return {
    scale,
    x: clampOffset(transform.x, geometry.image.width * scale, geometry.viewport.width),
    y: clampOffset(transform.y, geometry.image.height * scale, geometry.viewport.height),
  };
}

/** Zooms to `scale` keeping the image pixel under `focal` (viewport coordinates) where it is. */
export function zoomAt(transform: Transform, scale: number, focal: Point, geometry: Geometry): Transform {
  const { min, max } = scaleLimits(geometry);
  const next = Math.min(max, Math.max(min, scale));
  const fromCentre = { x: focal.x - geometry.viewport.width / 2, y: focal.y - geometry.viewport.height / 2 };
  const ratio = next / transform.scale;
  return clampTransform(
    {
      scale: next,
      x: fromCentre.x - (fromCentre.x - transform.x) * ratio,
      y: fromCentre.y - (fromCentre.y - transform.y) * ratio,
    },
    geometry,
  );
}

export function panBy(transform: Transform, delta: Point, geometry: Geometry): Transform {
  return clampTransform({ ...transform, x: transform.x + delta.x, y: transform.y + delta.y }, geometry);
}

/**
 * A double click or double tap: from fit to real size at that point, from anything else back to fit.
 * An image that already fits at real size goes to twice it instead, so the gesture always does something.
 */
export function toggleZoom(transform: Transform, focal: Point, geometry: Geometry): Transform {
  if (!isAtFit(transform, geometry)) return fitTransform(geometry);
  const fit = fitScale(geometry);
  return zoomAt(transform, fit >= 1 - SAME_SCALE ? 2 : 1, focal, geometry);
}

/**
 * The scale after one wheel event. A trackpad pinch arrives as a wheel with Ctrl held and small
 * deltas, a mouse wheel as about 100 pixels a notch (or 3 lines, `deltaMode` 1), so each has its own
 * rate; one event never moves more than a notch's worth.
 */
export function wheelScale(scale: number, deltaY: number, pinch: boolean, deltaMode = 0): number {
  const pixels = deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * 300 : deltaY;
  const capped = Math.max(-150, Math.min(150, pixels));
  return scale * Math.exp(-capped * (pinch ? 0.01 : 0.002));
}

export function isInsideImage(point: Point, transform: Transform, geometry: Geometry): boolean {
  const halfWidth = (geometry.image.width * transform.scale) / 2;
  const halfHeight = (geometry.image.height * transform.scale) / 2;
  const x = point.x - geometry.viewport.width / 2 - transform.x;
  const y = point.y - geometry.viewport.height / 2 - transform.y;
  return Math.abs(x) <= halfWidth && Math.abs(y) <= halfHeight;
}

/** Where the image's box sits in the viewport, for an absolutely placed view. */
export function imageFrame(transform: Transform, geometry: Geometry): { left: number; top: number; width: number; height: number } {
  const width = geometry.image.width * transform.scale;
  const height = geometry.image.height * transform.scale;
  return {
    left: geometry.viewport.width / 2 + transform.x - width / 2,
    top: geometry.viewport.height / 2 + transform.y - height / 2,
    width,
    height,
  };
}

export interface Touch extends Point {
  id: number;
}

/** A pointer that travels further than this was a drag, not a tap. */
const TAP_SLOP = 8;
/** Two taps this close in time and place are a double tap. */
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_SLOP = 32;

/**
 * One finger or a held mouse button pans, two fingers pinch and pan together, and a press that
 * neither moved nor had company is a tap. Fed every touch frame of one gesture, from the first
 * finger down to the last one up.
 */
export class TouchGesture {
  private last: readonly Touch[] = [];
  private travel = 0;
  private pinched = false;

  begin(touches: readonly Touch[]): void {
    this.last = touches;
    this.travel = 0;
    this.pinched = touches.length > 1;
  }

  move(touches: readonly Touch[], transform: Transform, geometry: Geometry): Transform {
    // Only fingers present in both frames say anything: one that just landed has no "before".
    const pairs = touches.flatMap((now) => {
      const before = this.last.find((touch) => touch.id === now.id);
      return before === undefined ? [] : [{ before, now }];
    });
    this.last = touches;
    if (touches.length > 1) this.pinched = true;
    const [first, second] = pairs;
    if (first === undefined) return transform;
    if (second === undefined) {
      const delta = { x: first.now.x - first.before.x, y: first.now.y - first.before.y };
      this.travel += Math.hypot(delta.x, delta.y);
      return panBy(transform, delta, geometry);
    }
    const spanBefore = Math.hypot(second.before.x - first.before.x, second.before.y - first.before.y);
    const spanNow = Math.hypot(second.now.x - first.now.x, second.now.y - first.now.y);
    const midBefore = { x: (first.before.x + second.before.x) / 2, y: (first.before.y + second.before.y) / 2 };
    const midNow = { x: (first.now.x + second.now.x) / 2, y: (first.now.y + second.now.y) / 2 };
    const zoomed = spanBefore > 0 ? zoomAt(transform, (transform.scale * spanNow) / spanBefore, midBefore, geometry) : transform;
    return panBy(zoomed, { x: midNow.x - midBefore.x, y: midNow.y - midBefore.y }, geometry);
  }

  /** Where the gesture tapped, or null when it was a drag or a pinch. */
  end(): Point | null {
    const at = this.last[0];
    const tapped = !this.pinched && this.travel <= TAP_SLOP && at !== undefined;
    this.last = [];
    return tapped ? { x: at.x, y: at.y } : null;
  }
}

export interface Tap extends Point {
  at: number;
}

export type TapAction = "close" | "toggle" | "none";

/**
 * What a tap does: outside the image it closes at once; on the image the second of a quick pair
 * toggles the zoom and a lone one does nothing, so a double tap never closes anything on its way.
 */
export function tapAction(tap: Tap, previous: Tap | null, transform: Transform, geometry: Geometry | null): TapAction {
  // With no size yet there is no image box to miss, and a tap anywhere is a way out.
  if (geometry === null || !isInsideImage(tap, transform, geometry)) return "close";
  if (previous === null) return "none";
  const quick = tap.at - previous.at <= DOUBLE_TAP_MS;
  const near = Math.hypot(tap.x - previous.x, tap.y - previous.y) <= DOUBLE_TAP_SLOP;
  return quick && near ? "toggle" : "none";
}

export type KeyAction = "close" | "previous" | "next" | "zoom-in" | "zoom-out" | "fit";

/** What a key does while the lightbox is open, or null for a key that is not its own. */
export function keyAction(key: string, group: { hasPrevious: boolean; hasNext: boolean }): KeyAction | null {
  switch (key) {
    case "Escape":
      return "close";
    case "ArrowLeft":
      return group.hasPrevious ? "previous" : null;
    case "ArrowRight":
      return group.hasNext ? "next" : null;
    case "+":
    case "=":
      return "zoom-in";
    case "-":
    case "_":
      return "zoom-out";
    case "0":
      return "fit";
    default:
      return null;
  }
}

/** The neighbour `by` steps along a group of `count`, or null at either end: a group does not wrap. */
export function stepIndex(index: number, by: -1 | 1, count: number): number | null {
  const next = index + by;
  return next < 0 || next >= count ? null : next;
}

/** A keyboard zoom step, about a wheel notch and a half. */
export const KEY_ZOOM_STEP = 1.4;
