import { describe, expect, it } from "vitest";

import type { DiffFile } from "../shared/review";
import { ContentsCache } from "./contents-cache";
import {
  activeSection,
  estimateSectionHeight,
  FOLD_BAR_HEIGHT,
  foldBars,
  nearestFirst,
  nextMounted,
  SECTION_HEADER_HEIGHT,
  sameSet,
  scrollTarget,
  sectionAt,
  sectionTops,
  THREAD_ESTIMATE,
  visibleLines,
  windowRange,
} from "./stream-model";

function file(partial: Partial<DiffFile>): DiffFile {
  return { path: "a.ts", status: "modified", binary: false, additions: 0, deletions: 0, hunks: [], ...partial };
}

const twoHunks = file({
  additions: 3,
  deletions: 2,
  hunks: [
    { oldStart: 10, oldLines: 7, newStart: 10, newLines: 8, header: "@@" },
    { oldStart: 40, oldLines: 6, newStart: 41, newLines: 6, header: "@@" },
  ],
});

describe("height estimation", () => {
  it("counts the new side plus deletions in unified, the longer side per hunk in split", () => {
    expect(visibleLines(twoHunks, "unified")).toBe(8 + 6 + 2);
    expect(visibleLines(twoHunks, "split")).toBe(8 + 6);
  });

  it("puts a fold bar above a hunk that starts past the context, between hunks and after the last", () => {
    expect(foldBars(twoHunks)).toBe(3);
    const atTop = file({ hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, header: "@@" }] });
    expect(foldBars(atTop)).toBe(1);
    expect(foldBars(file({ status: "added", hunks: twoHunks.hunks }))).toBe(0);
    expect(foldBars(file({ hunks: [] }))).toBe(0);
  });

  it("adds the header, lines, fold bars and threads", () => {
    const height = estimateSectionHeight(twoHunks, { layout: "unified", lineHeight: 18, threads: 2, collapsed: false });
    expect(height).toBe(SECTION_HEADER_HEIGHT + 8 + 16 * 18 + 3 * FOLD_BAR_HEIGHT + 2 * THREAD_ESTIMATE);
  });

  it("is just the header when collapsed, and a message for a binary file", () => {
    expect(estimateSectionHeight(twoHunks, { layout: "split", lineHeight: 18, threads: 4, collapsed: true })).toBe(
      SECTION_HEADER_HEIGHT,
    );
    const binary = estimateSectionHeight(file({ binary: true }), { layout: "split", lineHeight: 18, threads: 0, collapsed: false });
    expect(binary).toBeGreaterThan(SECTION_HEADER_HEIGHT);
    expect(binary).toBeLessThan(SECTION_HEADER_HEIGHT + 100);
  });
});

describe("section positions", () => {
  const heights = [100, 50, 200, 30];
  const tops = sectionTops(heights);

  it("stacks sections in order", () => {
    expect(tops).toEqual([0, 100, 150, 350]);
  });

  it("finds the section containing a point", () => {
    expect(sectionAt(tops, 0)).toBe(0);
    expect(sectionAt(tops, 99)).toBe(0);
    expect(sectionAt(tops, 100)).toBe(1);
    expect(sectionAt(tops, 349)).toBe(2);
    expect(sectionAt(tops, 10_000)).toBe(3);
    expect(sectionAt([], 10)).toBe(-1);
  });

  it("makes the file under the top edge active, past whatever is drawn above the sections", () => {
    expect(activeSection(tops, 0)).toBe(0);
    expect(activeSection(tops, 98)).toBe(1);
    expect(activeSection(tops, 120)).toBe(1);
    // A 60px chapter heading above the first section.
    expect(activeSection(tops, 150, 60)).toBe(0);
    expect(activeSection(tops, 165, 60)).toBe(1);
    expect(activeSection(tops, 30, 60)).toBe(0);
  });

  it("aims a section at the top, clamped to what can scroll", () => {
    expect(scrollTarget(tops, 2, 0, 0, 1000, 400)).toBe(150);
    expect(scrollTarget(tops, 2, 60, 10, 1000, 400)).toBe(220);
    expect(scrollTarget(tops, 3, 0, 0, 380, 300)).toBe(80);
    expect(scrollTarget(tops, 1, 0, 0, 200, 400)).toBe(0);
  });
});

describe("window range", () => {
  const heights = Array.from({ length: 300 }, () => 100);
  const tops = sectionTops(heights);

  it("covers the viewport stretched by screens above and below", () => {
    expect(windowRange(tops, heights, 5000, 500, 1, 1)).toEqual({ first: 45, last: 59 });
    expect(windowRange(tops, heights, 5000, 500, 0, 0)).toEqual({ first: 50, last: 54 });
  });

  it("stops at either end", () => {
    expect(windowRange(tops, heights, 0, 500, 2, 1)).toEqual({ first: 0, last: 9 });
    expect(windowRange(tops, heights, 29_800, 500, 1, 3)).toEqual({ first: 293, last: 299 });
    expect(windowRange([], [], 0, 500, 1, 1)).toBeNull();
  });

  it("keeps one huge section in range while any of it is on screen", () => {
    const mixed = [100, 20_000, 100];
    expect(windowRange(sectionTops(mixed), mixed, 10_000, 500, 1, 1)).toEqual({ first: 1, last: 1 });
  });

  it("orders read-ahead nearest the viewport first", () => {
    expect(nearestFirst({ first: 3, last: 7 }, 5)).toEqual([5, 4, 6, 3, 7]);
  });
});

describe("mounted sections", () => {
  const keys = ["a", "b", "c", "d", "e", "f"];

  it("mounts the inner window and keeps what is mounted inside the outer one", () => {
    const first = nextMounted(keys, new Set(), { first: 1, last: 2 }, { first: 0, last: 3 }, new Set());
    expect([...first]).toEqual(["b", "c"]);
    const scrolled = nextMounted(keys, first, { first: 2, last: 3 }, { first: 1, last: 4 }, new Set());
    expect([...scrolled]).toEqual(["b", "c", "d"]);
    const far = nextMounted(keys, scrolled, { first: 4, last: 5 }, { first: 3, last: 5 }, new Set());
    expect([...far]).toEqual(["d", "e", "f"]);
  });

  it("keeps a section with unsaved edits however far it is", () => {
    const next = nextMounted(keys, new Set(["a"]), { first: 4, last: 5 }, { first: 4, last: 5 }, new Set(["a"]));
    expect([...next]).toEqual(["a", "e", "f"]);
  });

  it("compares sets by content", () => {
    expect(sameSet(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true);
    expect(sameSet(new Set(["a"]), new Set(["a", "b"]))).toBe(false);
  });
});

describe("contents cache", () => {
  it("shares a read in flight, keeps it, and re-reads once the generation moves", async () => {
    const cache = new ContentsCache<string>(2);
    let reads = 0;
    const fetch = () => {
      reads += 1;
      return Promise.resolve(`v${reads}`);
    };
    const [one, two] = await Promise.all([cache.load("k", 0, fetch), cache.load("k", 0, fetch)]);
    expect([one, two, reads]).toEqual(["v1", "v1", 1]);
    expect(await cache.load("k", 0, fetch)).toBe("v1");
    expect(cache.fresh("k", 1)).toBe(false);
    expect(await cache.load("k", 1, fetch)).toBe("v2");
    expect(cache.get("k")).toEqual({ value: "v2", nonce: 1 });
  });

  it("runs at most `concurrency` reads at once", async () => {
    const cache = new ContentsCache<number>(2);
    let running = 0;
    let peak = 0;
    const fetch = (value: number) => async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return value;
    };
    const values = await Promise.all([1, 2, 3, 4, 5].map((value) => cache.load(`k${value}`, 0, fetch(value))));
    expect(values).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });
});
