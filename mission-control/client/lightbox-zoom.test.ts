import { describe, expect, it } from "vitest";

import {
  MAX_ZOOM,
  TouchGesture,
  clampTransform,
  fitMargin,
  fitScale,
  fitTransform,
  imageFrame,
  isAtFit,
  isInsideImage,
  keyAction,
  panBy,
  stepIndex,
  tapAction,
  toggleZoom,
  wheelScale,
  zoomAt,
  type Geometry,
  type Transform,
} from "./lightbox-zoom";

/** A 2000×1000 image in a 1000×800 window with a 40 point margin: fit is 0.46. */
const wide: Geometry = { image: { width: 2000, height: 1000 }, viewport: { width: 1000, height: 800 }, margin: 40 };
/** An icon far smaller than the window. */
const small: Geometry = { image: { width: 64, height: 64 }, viewport: { width: 1000, height: 800 }, margin: 40 };

/** The image pixel under a viewport point, measured from the image's centre. */
function pixelUnder(point: { x: number; y: number }, transform: Transform, geometry: Geometry) {
  return {
    x: (point.x - geometry.viewport.width / 2 - transform.x) / transform.scale,
    y: (point.y - geometry.viewport.height / 2 - transform.y) / transform.scale,
  };
}

describe("lightbox fit", () => {
  it("fits the whole image inside the margin and never blows a small one up", () => {
    expect(fitScale(wide)).toBeCloseTo(0.46);
    expect(fitScale(small)).toBe(1);
    expect(fitScale({ ...wide, image: { width: 500, height: 3000 } })).toBeCloseTo(0.24);
    expect(fitScale({ ...wide, image: { width: 0, height: 0 } })).toBe(1);
  });

  it("keeps a slimmer margin on a narrow window", () => {
    expect(fitMargin({ width: 390, height: 844 })).toBe(12);
    expect(fitMargin({ width: 1440, height: 900 })).toBe(40);
  });

  it("centres the fitted image", () => {
    expect(imageFrame(fitTransform(wide), wide)).toEqual({ left: 40, top: 170, width: 920, height: 460 });
    expect(imageFrame(fitTransform(small), small)).toEqual({ left: 468, top: 368, width: 64, height: 64 });
  });
});

describe("lightbox zoom and pan", () => {
  it("keeps the pixel under the pointer where it is while zooming", () => {
    const focal = { x: 620, y: 430 };
    const before = fitTransform(wide);
    const after = zoomAt(before, 1, focal, wide);
    expect(after.scale).toBe(1);
    const then = pixelUnder(focal, before, wide);
    const now = pixelUnder(focal, after, wide);
    expect(now.x).toBeCloseTo(then.x);
    expect(now.y).toBeCloseTo(then.y);
  });

  it("stops at fit on the way out and at several times real size on the way in", () => {
    expect(zoomAt(fitTransform(wide), 0.01, { x: 0, y: 0 }, wide)).toEqual(fitTransform(wide));
    expect(zoomAt(fitTransform(wide), 99, { x: 500, y: 400 }, wide).scale).toBe(MAX_ZOOM);
    expect(zoomAt(fitTransform(small), 0.2, { x: 500, y: 400 }, small).scale).toBe(1);
  });

  it("never pans an edge of the image past the viewport's, and keeps a fitting axis centred", () => {
    const zoomed = { scale: 1, x: 0, y: 0 };
    // At real size the image is 2000 wide in a 1000 window: 500 of reach each way, 100 vertically.
    expect(panBy(zoomed, { x: 9999, y: 9999 }, wide)).toEqual({ scale: 1, x: 500, y: 100 });
    expect(panBy(zoomed, { x: -9999, y: -9999 }, wide)).toEqual({ scale: 1, x: -500, y: -100 });
    expect(panBy(zoomed, { x: 120, y: -30 }, wide)).toEqual({ scale: 1, x: 120, y: -30 });
    expect(panBy(fitTransform(wide), { x: 300, y: 300 }, wide)).toEqual(fitTransform(wide));
    // 0.6: wider than the window, shorter than it.
    expect(clampTransform({ scale: 0.6, x: 50, y: 50 }, wide)).toEqual({ scale: 0.6, x: 50, y: 0 });
  });

  it("zooms toward a corner without leaving a gap there", () => {
    const corner = zoomAt(fitTransform(wide), 2, { x: 40, y: 170 }, wide);
    const frame = imageFrame(corner, wide);
    expect(frame.left).toBeLessThanOrEqual(0);
    expect(frame.top).toBeLessThanOrEqual(0);
    expect(frame.left + frame.width).toBeGreaterThanOrEqual(wide.viewport.width);
  });

  it("toggles between fit and real size, and gives a small image twice its size", () => {
    const real = toggleZoom(fitTransform(wide), { x: 500, y: 400 }, wide);
    expect(real).toEqual({ scale: 1, x: 0, y: 0 });
    expect(toggleZoom(real, { x: 10, y: 10 }, wide)).toEqual(fitTransform(wide));
    expect(toggleZoom({ scale: 3.2, x: 40, y: -10 }, { x: 10, y: 10 }, wide)).toEqual(fitTransform(wide));
    expect(toggleZoom(fitTransform(small), { x: 500, y: 400 }, small).scale).toBe(2);
    expect(isAtFit(fitTransform(wide), wide)).toBe(true);
    expect(isAtFit(real, wide)).toBe(false);
  });

  it("reads a wheel notch, a line-mode wheel and a trackpad pinch at their own rates", () => {
    expect(wheelScale(1, -100, false)).toBeCloseTo(Math.exp(0.2));
    expect(wheelScale(1, 100, false)).toBeCloseTo(Math.exp(-0.2));
    expect(wheelScale(1, -3, false, 1)).toBeCloseTo(wheelScale(1, -99, false));
    expect(wheelScale(1, -10, true)).toBeCloseTo(Math.exp(0.1));
    // One event is capped, so a flung wheel does not jump straight to the limit.
    expect(wheelScale(1, -5000, false)).toBe(wheelScale(1, -150, false));
    expect(wheelScale(2, 0, false)).toBe(2);
  });
});

describe("lightbox gestures", () => {
  it("pans with one finger once zoomed", () => {
    const gesture = new TouchGesture();
    gesture.begin([{ id: 1, x: 500, y: 400 }]);
    const moved = gesture.move([{ id: 1, x: 560, y: 380 }], { scale: 1, x: 0, y: 0 }, wide);
    expect(moved).toEqual({ scale: 1, x: 60, y: -20 });
    expect(gesture.end()).toBeNull();
  });

  it("pinches around the fingers' midpoint and follows it", () => {
    const gesture = new TouchGesture();
    const start = { scale: 1, x: 0, y: 0 };
    gesture.begin([{ id: 1, x: 400, y: 400 }]);
    // The second finger lands: nothing moves yet.
    expect(gesture.move([{ id: 1, x: 400, y: 400 }, { id: 2, x: 600, y: 400 }], start, wide)).toEqual(start);
    const spread = gesture.move([{ id: 1, x: 300, y: 400 }, { id: 2, x: 700, y: 400 }], start, wide);
    expect(spread.scale).toBeCloseTo(2);
    expect(spread.x).toBeCloseTo(0);
    const dragged = gesture.move([{ id: 1, x: 330, y: 410 }, { id: 2, x: 730, y: 410 }], spread, wide);
    expect(dragged.scale).toBeCloseTo(2);
    expect(dragged.x).toBeCloseTo(30);
    expect(dragged.y).toBeCloseTo(10);
    // Lifting one finger carries on as a pan, with no jump to the finger that stayed.
    expect(gesture.move([{ id: 2, x: 730, y: 410 }], dragged, wide)).toEqual(dragged);
    expect(gesture.end()).toBeNull();
  });

  it("calls a still press a tap and a drag not one", () => {
    const tap = new TouchGesture();
    tap.begin([{ id: 0, x: 10, y: 20 }]);
    tap.move([{ id: 0, x: 12, y: 21 }], fitTransform(wide), wide);
    expect(tap.end()).toEqual({ x: 12, y: 21 });

    const drag = new TouchGesture();
    drag.begin([{ id: 0, x: 10, y: 20 }]);
    drag.move([{ id: 0, x: 40, y: 20 }], fitTransform(wide), wide);
    drag.move([{ id: 0, x: 10, y: 20 }], fitTransform(wide), wide);
    expect(drag.end()).toBeNull();
  });
});

describe("lightbox open and close", () => {
  const fit = fitTransform(wide);

  it("closes on a tap on the curtain and not on one on the image", () => {
    expect(isInsideImage({ x: 500, y: 400 }, fit, wide)).toBe(true);
    expect(isInsideImage({ x: 500, y: 100 }, fit, wide)).toBe(false);
    expect(tapAction({ x: 500, y: 100, at: 1000 }, null, fit, wide)).toBe("close");
    expect(tapAction({ x: 20, y: 400, at: 1000 }, null, fit, wide)).toBe("close");
    expect(tapAction({ x: 500, y: 400, at: 1000 }, null, fit, wide)).toBe("none");
  });

  it("follows the image as it is zoomed and panned", () => {
    const zoomed = { scale: 1, x: 500, y: 0 };
    // Panned hard right, the image's left edge sits at the window's, so the far left is still image.
    expect(tapAction({ x: 5, y: 400, at: 1000 }, null, zoomed, wide)).toBe("none");
    expect(tapAction({ x: 500, y: 100, at: 1000 }, null, { scale: 1, x: 0, y: 100 }, wide)).toBe("none");
  });

  it("toggles on the second of two quick taps in one place", () => {
    const first = { x: 500, y: 400, at: 1000 };
    expect(tapAction({ x: 505, y: 398, at: 1200 }, first, fit, wide)).toBe("toggle");
    expect(tapAction({ x: 505, y: 398, at: 1900 }, first, fit, wide)).toBe("none");
    expect(tapAction({ x: 700, y: 500, at: 1200 }, first, fit, wide)).toBe("none");
    // A second tap that lands on the curtain closes rather than zooms.
    expect(tapAction({ x: 500, y: 100, at: 1100 }, first, fit, wide)).toBe("close");
  });

  it("closes on any tap while there is no image to miss", () => {
    expect(tapAction({ x: 500, y: 400, at: 1000 }, null, fit, null)).toBe("close");
  });

  it("maps Escape, the arrows and the zoom keys, and leaves the rest to the app", () => {
    const middle = { hasPrevious: true, hasNext: true };
    const alone = { hasPrevious: false, hasNext: false };
    expect(keyAction("Escape", alone)).toBe("close");
    expect(keyAction("ArrowLeft", middle)).toBe("previous");
    expect(keyAction("ArrowRight", middle)).toBe("next");
    expect(keyAction("ArrowLeft", alone)).toBeNull();
    expect(keyAction("ArrowRight", { hasPrevious: true, hasNext: false })).toBeNull();
    expect(keyAction("+", alone)).toBe("zoom-in");
    expect(keyAction("=", alone)).toBe("zoom-in");
    expect(keyAction("-", alone)).toBe("zoom-out");
    expect(keyAction("0", alone)).toBe("fit");
    expect(keyAction("a", middle)).toBeNull();
    expect(keyAction("Tab", middle)).toBeNull();
  });

  it("steps through a group and stops at its ends", () => {
    expect(stepIndex(0, 1, 3)).toBe(1);
    expect(stepIndex(2, -1, 3)).toBe(1);
    expect(stepIndex(0, -1, 3)).toBeNull();
    expect(stepIndex(2, 1, 3)).toBeNull();
    expect(stepIndex(0, 1, 1)).toBeNull();
  });
});
