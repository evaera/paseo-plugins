import { describe, expect, it } from "vitest";

import {
  FITTED_COLUMNS,
  columnOffsets,
  fittedColumnWidth,
  growingHeight,
  SPLIT_MIN_WIDTH,
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

  it("gives an unfolded foldable and a tablet one pane at a time", () => {
    expect(layoutTier(false, 951)).toBe("medium");
    expect(layoutTier(false, 1024)).toBe("medium");
    expect(layoutTier(false, 1366)).toBe("medium");
  });

  it("gives a desktop window with Paseo's 320 pt sidebar open one pane at a time", () => {
    expect(layoutTier(false, 1440 - 320)).toBe("medium");
    expect(layoutTier(false, 1680 - 320)).toBe("medium");
    expect(layoutTier(false, SPLIT_MIN_WIDTH - 1)).toBe("medium");
  });

  it("keeps the split from the threshold up, a 1440 pt window with the sidebar closed included", () => {
    expect(layoutTier(false, SPLIT_MIN_WIDTH)).toBe("wide");
    expect(layoutTier(false, 1440)).toBe("wide");
    expect(layoutTier(false, 1920 - 320)).toBe("wide");
  });

  it("puts the threshold where the split's default shares still hold a readable chat and three whole columns", () => {
    const chatShare = 0.36;
    const handle = 9;
    const threeColumns = 3 * 280 + 2 * FITTED_COLUMNS.gap + 2 * 12;
    expect(chatShare * SPLIT_MIN_WIDTH).toBeGreaterThanOrEqual(480);
    expect((1 - chatShare) * SPLIT_MIN_WIDTH - handle).toBeGreaterThanOrEqual(threeColumns);
    // And not much more: 20 pt narrower and the board cuts its third column.
    expect((1 - chatShare) * (SPLIT_MIN_WIDTH - 20) - handle).toBeLessThan(threeColumns);
  });

  it("draws wide until the surface has been measured", () => {
    expect(layoutTier(false, 0)).toBe("wide");
  });
});

describe("fitted board columns", () => {
  it("fits two whole columns beside the folded strip in an unfolded foldable's board pane", () => {
    const width = fittedColumnWidth(600, 3, 1);
    expect(width).toBeGreaterThanOrEqual(FITTED_COLUMNS.min);
    // Two columns, the strip, the gaps and the padding fill the pane without cutting the second column.
    expect(2 * width + FITTED_COLUMNS.gap + 40 + FITTED_COLUMNS.gap + 2 * FITTED_COLUMNS.pad).toBeLessThanOrEqual(600);
  });

  it("gives a lone column the pane, up to the cap", () => {
    expect(fittedColumnWidth(300, 1, 0)).toBe(280);
    expect(fittedColumnWidth(900, 1, 0)).toBe(FITTED_COLUMNS.max);
  });

  it("shows one whole column when two would be too narrow", () => {
    expect(fittedColumnWidth(480, 4, 0)).toBe(FITTED_COLUMNS.max);
    expect(fittedColumnWidth(420, 4, 0)).toBe(FITTED_COLUMNS.max);
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
