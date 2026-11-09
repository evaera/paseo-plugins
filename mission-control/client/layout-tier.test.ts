import { describe, expect, it } from "vitest";

import {
  TABLET_COLUMNS,
  columnOffsets,
  fittedColumnWidth,
  growingHeight,
  layoutTier,
  nextOffset,
  overflowEdges,
  touchPadding,
  twinText,
} from "./layout-tier";

describe("the layout tier", () => {
  it("is the phone layout whenever the host says compact", () => {
    expect(layoutTier(true, 466)).toBe("phone");
    expect(layoutTier(true, 1200)).toBe("phone");
  });

  it("fits an unfolded foldable and a 1024 pt tablet in the tablet layout", () => {
    expect(layoutTier(false, 951)).toBe("tablet");
    expect(layoutTier(false, 1024)).toBe("tablet");
  });

  it("leaves a desktop window wide, Paseo's sidebar open included", () => {
    expect(layoutTier(false, 1120)).toBe("wide");
    expect(layoutTier(false, 1046)).toBe("wide");
    expect(layoutTier(false, 1600)).toBe("wide");
  });

  it("draws wide until the surface has been measured", () => {
    expect(layoutTier(false, 0)).toBe("wide");
  });
});

describe("tablet board columns", () => {
  it("fits two whole columns beside the folded strip in an unfolded foldable's board pane", () => {
    const width = fittedColumnWidth(600, 3, 1);
    expect(width).toBeGreaterThanOrEqual(TABLET_COLUMNS.min);
    // Two columns, the strip, the gaps and the padding fill the pane without cutting the second column.
    expect(2 * width + TABLET_COLUMNS.gap + 40 + TABLET_COLUMNS.gap + 2 * TABLET_COLUMNS.pad).toBeLessThanOrEqual(600);
  });

  it("gives a lone column the pane, up to the cap", () => {
    expect(fittedColumnWidth(300, 1, 0)).toBe(280);
    expect(fittedColumnWidth(900, 1, 0)).toBe(TABLET_COLUMNS.max);
  });

  it("shows one whole column when two would be too narrow", () => {
    expect(fittedColumnWidth(480, 4, 0)).toBe(TABLET_COLUMNS.max);
    expect(fittedColumnWidth(420, 4, 0)).toBe(TABLET_COLUMNS.max);
  });

  it("never goes wider than the pane itself", () => {
    expect(fittedColumnWidth(200, 2, 0)).toBe(180);
  });

  it("snaps to each column's start and moves a whole column per press", () => {
    const offsets = columnOffsets([40, 270, 270, 270], { gap: 10 });
    expect(offsets).toEqual([0, 50, 330, 610]);
    expect(nextOffset(offsets, 0, 1)).toBe(50);
    expect(nextOffset(offsets, 50, 1)).toBe(330);
    expect(nextOffset(offsets, 331, 1)).toBe(610);
    expect(nextOffset(offsets, 610, 1)).toBe(610);
    expect(nextOffset(offsets, 330, -1)).toBe(50);
    expect(nextOffset(offsets, 0, -1)).toBe(0);
  });
});

describe("a scrolled row's edges", () => {
  it("says which ends have more beyond them", () => {
    expect(overflowEdges(0, 300, 800)).toEqual({ start: false, end: true });
    expect(overflowEdges(250, 300, 800)).toEqual({ start: true, end: true });
    expect(overflowEdges(500, 300, 800)).toEqual({ start: true, end: false });
    expect(overflowEdges(0, 300, 290)).toEqual({ start: false, end: false });
  });
});

describe("a composer that grows with its text", () => {
  it("is one line while empty or unmeasured, grows with the twin, and stops at the cap", () => {
    expect(growingHeight(null, 21, 1, 6)).toBe(21);
    expect(growingHeight(0, 21, 1, 6)).toBe(21);
    expect(growingHeight(63, 21, 1, 6)).toBe(63);
    expect(growingHeight(400, 21, 1, 6)).toBe(126);
  });

  it("shrinks back when the text does, since the twin is measured afresh", () => {
    expect(growingHeight(84, 21, 1, 6)).toBe(84);
    expect(growingHeight(21, 21, 1, 6)).toBe(21);
  });

  it("holds an empty last line open in the twin", () => {
    expect(twinText("")).toBe(" ");
    expect(twinText("one\n")).toBe("one\n ");
    expect(twinText("one")).toBe("one");
  });
});

describe("a touch area around a small mark", () => {
  it("pads each side to reach 44 points without moving the mark", () => {
    expect(touchPadding(18)).toBe(13);
    expect(18 + 2 * touchPadding(18)).toBe(44);
  });

  it("rounds up, so an odd gap still reaches the target", () => {
    expect(touchPadding(17)).toBe(14);
  });

  it("adds nothing to a mark already the target's size or bigger", () => {
    expect(touchPadding(44)).toBe(0);
    expect(touchPadding(60)).toBe(0);
  });
});
