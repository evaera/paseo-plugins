/**
 * Every worker's face: a small pixel-art robot or alien, the same one every
 * time for the same agent, so a worker is recognisable across the board, its
 * card's view and a reload. Pure.
 *
 * The agent's id is hashed into a seed, and the seed picks one of each part —
 * a head, eyes, a mouth, something on top, something at the sides — and a
 * palette, on a 16×16 grid. The result is SVG markup made of `<rect>`s only,
 * which Paseo's `Icon` draws (`{ svg }`); it allows no `<style>`, so every
 * colour is on its shape.
 *
 * A face can strike a pose, a frame of a short loop (`AvatarFrame`): a worker
 * who needs the user raises a hand and waves it, and a working one rests
 * its chin on its hand with its head tilted, now and then blinking or
 * sitting up. One waiting on others dozes, a Zzz floating up beside it (drawn
 * by the view, over the face). `avatarFrame` says which frame a mood shows at a tick; the
 * view runs the clock.
 *
 * The colours are fixed, not the theme's. A face is only recognisable if it
 * looks the same in every theme, the way a photo does; it sits on its own
 * tile, so it reads on any ground.
 */

import type { AgentSummary, FleetCard } from "../shared/fleet";

const GRID = 16;

interface Palette {
  /** The tile behind the face. */
  ground: string;
  head: string;
  accent: string;
  eye: string;
}

/** Tile grounds: dark and muted, so a face stands out on them and they sit quietly on a card. */
const GROUNDS = ["#2b3a55", "#3b2f4f", "#2f4a3f", "#4a3a2a", "#3a2f3a", "#25404a", "#40332f", "#2f3550"];
const HEADS = ["#9ad46b", "#7fb8e8", "#e8b45a", "#d98cc4", "#8fd6c8", "#c9c2b0", "#e88a7a", "#a99be6", "#6fcf97", "#f0d264"];
const ACCENTS = ["#ff6b6b", "#ffd166", "#4cc9f0", "#f72585", "#b5e48c", "#ff9f1c", "#c77dff", "#06d6a0"];
const EYES = ["#ffffff", "#1b1b2f", "#ffe66d", "#7df9ff", "#ff4d6d"];

/** FNV-1a: a stable 32-bit hash of the agent id. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

/** mulberry32: a small seeded generator, so each part is its own draw from the one seed. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length)] as T;
}

/** A colour made darker by `amount` (0–1), for a face's outline and shoulders. */
export function shade(hex: string, amount: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number) => Math.round(((value >> shift) & 0xff) * (1 - amount));
  return `#${[channel(16), channel(8), channel(0)].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

/** Perceived lightness, 0–1, for telling whether eyes would show on a head. */
export function lightness(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  return (0.299 * ((value >> 16) & 0xff) + 0.587 * ((value >> 8) & 0xff) + 0.114 * (value & 0xff)) / 255;
}

type Pixel = [x: number, y: number, w: number, h: number, color: string];

/** A head as rows of spans: each `[y, x, w]`, so a dome or an oval is as easy as a box. */
type HeadShape = { rows: Array<[number, number, number]>; top: number; bottom: number; eyeY: number };

const HEADS_ROBOT: HeadShape[] = [
  // A box.
  { rows: rows(4, 11, 4, 8), top: 4, bottom: 11, eyeY: 7 },
  // Wide and low.
  { rows: rows(5, 11, 3, 10), top: 5, bottom: 11, eyeY: 7 },
  // Tall and narrow.
  { rows: rows(3, 11, 5, 6), top: 3, bottom: 11, eyeY: 6 },
  // A box with its corners off.
  { rows: [[4, 5, 6], ...rows(5, 10, 4, 8), [11, 5, 6]], top: 4, bottom: 11, eyeY: 7 },
];

const HEADS_ALIEN: HeadShape[] = [
  // An oval.
  {
    rows: [[3, 6, 4], [4, 5, 6], ...rows(5, 9, 4, 8), [10, 5, 6], [11, 6, 4]],
    top: 3,
    bottom: 11,
    eyeY: 6,
  },
  // A big brain over a narrow chin.
  {
    rows: [[3, 5, 6], ...rows(4, 7, 3, 10), [8, 4, 8], [9, 5, 6], [10, 6, 4], [11, 7, 2]],
    top: 3,
    bottom: 11,
    eyeY: 6,
  },
  // A dome.
  { rows: [[4, 6, 4], [5, 5, 6], ...rows(6, 11, 4, 8)], top: 4, bottom: 11, eyeY: 8 },
];

function rows(from: number, to: number, x: number, w: number): Array<[number, number, number]> {
  return Array.from({ length: to - from + 1 }, (_, index) => [from + index, x, w] as [number, number, number]);
}

/** What a face is doing: still, wanting the user, or at work. */
export type AvatarMood = "rest" | "needs" | "working" | "waiting";
export type AvatarFrame = "rest" | "raise" | "wave" | "think" | "think-blink" | "ponder" | "doze-1" | "doze-2" | "doze-3";

/** How many z's float beside a dozing face in `frame`: one, two, three, and round again; none otherwise. */
export function dozeCount(frame: AvatarFrame): number {
  return frame === "doze-1" ? 1 : frame === "doze-2" ? 2 : frame === "doze-3" ? 3 : 0;
}

/** Each mood's loop, one frame per tick of the view's clock. */
const LOOPS: Record<AvatarMood, readonly AvatarFrame[]> = {
  rest: ["rest"],
  waiting: ["doze-1", "doze-1", "doze-2", "doze-2", "doze-3", "doze-3", "doze-3"],
  needs: ["raise", "raise", "raise", "wave", "wave", "wave"],
  working: [
    ...Array<AvatarFrame>(8).fill("think"),
    "think-blink",
    ...Array<AvatarFrame>(5).fill("think"),
    ...Array<AvatarFrame>(6).fill("ponder"),
  ],
};

/** What a worker's face is doing: wanting the user, working, or still. An error is still; its dot says enough. */
export function avatarMood(agent: Pick<AgentSummary, "status" | "pendingPermissions">, column?: FleetCard["column"]): AvatarMood {
  if (agent.status === "error") return "rest";
  if (agent.pendingPermissions > 0 || column === "blocked") return "needs";
  if (column === "waiting") return "waiting";
  if (column === "working" || (column === undefined && (agent.status === "running" || agent.status === "initializing"))) return "working";
  return "rest";
}

/** The frame `mood` shows at `tick`, offset by the agent so a board of workers does not move in step. Pure. */
export function avatarFrame(mood: AvatarMood, tick: number, agentId: string): AvatarFrame {
  const loop = LOOPS[mood];
  return loop[(tick + hash(agentId)) % loop.length] ?? "rest";
}

/** The worker's face as SVG markup, the same for the same agent id every time, in `frame`'s pose. */
export function avatarSvg(agentId: string, frame: AvatarFrame = "rest"): string {
  const next = generator(hash(agentId));
  const alien = next() < 0.4;
  const head = pick(next, alien ? HEADS_ALIEN : HEADS_ROBOT);
  const palette: Palette = {
    ground: pick(next, GROUNDS),
    head: pick(next, HEADS),
    accent: pick(next, ACCENTS),
    eye: pick(next, EYES),
  };
  const dark = shade(palette.head, 0.45);
  // Eyes the head would swallow — light on light, dark on dark — take whichever of white and ink stands out.
  const eyeColor =
    Math.abs(lightness(palette.eye) - lightness(palette.head)) >= 0.12
      ? palette.eye
      : lightness(palette.head) > 0.5
        ? "#1b1b2f"
        : "#ffffff";
  // Drawn in layers, so a pose can move the head and blink the eyes: the body, the head and what is on it,
  // the eyes, and the mouth and cheeks.
  const body: Pixel[] = [];
  const pixels: Pixel[] = [];
  const eyePixels: Pixel[] = [];
  const features: Pixel[] = [];
  const cx = 8;

  // Shoulders and neck, under the head.
  body.push([cx - 1, head.bottom + 1, 2, 1, dark]);
  body.push([cx - 4, head.bottom + 2, 8, GRID - head.bottom - 2, dark]);
  body.push([cx - 1, head.bottom + 3, 2, 1, palette.accent]);

  // Something on top.
  const top = Math.floor(next() * 5);
  if (top === 0) {
    pixels.push([cx, head.top - 2, 1, 2, dark], [cx, head.top - 3, 1, 1, palette.accent]);
  } else if (top === 1) {
    pixels.push([cx - 3, head.top - 2, 1, 2, dark], [cx + 2, head.top - 2, 1, 2, dark]);
    pixels.push([cx - 3, head.top - 3, 1, 1, palette.accent], [cx + 2, head.top - 3, 1, 1, palette.accent]);
  } else if (top === 2 && alien) {
    pixels.push([cx - 3, head.top - 1, 1, 1, dark], [cx - 4, head.top - 2, 1, 1, palette.accent]);
    pixels.push([cx + 2, head.top - 1, 1, 1, dark], [cx + 3, head.top - 2, 1, 1, palette.accent]);
  } else if (top === 3) {
    pixels.push([cx - 1, head.top - 1, 2, 1, palette.accent]);
  }

  // The head itself, outlined in its own darker shade.
  head.rows.forEach(([y, x, w]) => pixels.push([x - 1, y, w + 2, 1, dark]));
  pixels.push([head.rows[0]?.[1] ?? 4, head.top - 1, head.rows[0]?.[2] ?? 8, 1, dark]);
  const last = head.rows[head.rows.length - 1];
  if (last !== undefined) pixels.push([last[1], head.bottom + 1, last[2], 1, dark]);
  head.rows.forEach(([y, x, w]) => pixels.push([x, y, w, 1, palette.head]));

  // At the sides.
  const side = Math.floor(next() * 3);
  const sideRow = head.rows.find(([y]) => y === head.eyeY + 1) ?? head.rows[Math.floor(head.rows.length / 2)];
  if (sideRow !== undefined && side > 0) {
    const [y, x, w] = sideRow;
    const tall = side === 1 ? 2 : 1;
    pixels.push([x - 2, y, 1, tall, palette.accent], [x + w + 1, y, 1, tall, palette.accent]);
  }

  // Eyes.
  const eyes = Math.floor(next() * 5);
  const ey = head.eyeY;
  if (eyes === 0) {
    eyePixels.push([cx - 3, ey, 2, 2, eyeColor], [cx + 1, ey, 2, 2, eyeColor]);
    eyePixels.push([cx - 3, ey, 1, 1, dark], [cx + 1, ey, 1, 1, dark]);
  } else if (eyes === 1) {
    eyePixels.push([cx - 2, ey, 1, 1, eyeColor], [cx + 1, ey, 1, 1, eyeColor]);
  } else if (eyes === 2) {
    const row = head.rows.find(([y]) => y === ey);
    const [, x, w] = row ?? [ey, 5, 6];
    eyePixels.push([x + 1, ey, w - 2, 2, dark], [x + 2, ey, w - 4, 1, eyeColor]);
  } else if (eyes === 3) {
    eyePixels.push([cx - 1, ey, 2, 2, eyeColor], [cx, ey, 1, 1, dark]);
  } else {
    eyePixels.push([cx - 3, ey + 1, 2, 1, eyeColor], [cx + 1, ey + 1, 2, 1, eyeColor]);
  }

  // A mouth.
  const mouth = Math.floor(next() * 5);
  const my = head.bottom - 1;
  if (mouth === 0) {
    features.push([cx - 2, my, 1, 1, dark], [cx, my, 1, 1, dark], [cx + 1, my, 1, 1, dark]);
  } else if (mouth === 1) {
    features.push([cx - 2, my, 4, 1, dark]);
  } else if (mouth === 2) {
    features.push([cx - 2, my - 1, 1, 1, dark], [cx + 1, my - 1, 1, 1, dark], [cx - 1, my, 2, 1, dark]);
  } else if (mouth === 3) {
    features.push([cx - 2, my, 4, 1, dark], [cx - 1, my, 1, 1, eyeColor], [cx + 1, my, 1, 1, eyeColor]);
  }

  // Cheeks, now and then.
  if (next() < 0.3) {
    features.push([cx - 4, my - 1, 1, 1, palette.accent], [cx + 3, my - 1, 1, 1, palette.accent]);
  }

  // The pose. A lean moves the whole head a pixel towards the hand; a blink shuts the eyes to one line along their foot.
  const tilt = frame === "think" || frame === "think-blink" ? 1 : 0;
  const lean = (pixel: Pixel): Pixel => (tilt === 0 ? pixel : [pixel[0] + tilt, pixel[1], pixel[2], pixel[3], pixel[4]]);
  const lid = Math.max(...eyePixels.map(([, y, , h]) => y + h - 1));
  const shut = frame === "think-blink" ? eyePixels.map(([x, , w]): Pixel => [x, lid, w, 1, dark]) : eyePixels;
  const pose: Pixel[] = [];
  const skin = palette.head;
  const arm = shade(palette.head, 0.3);
  if (frame === "raise" || frame === "wave") {
    // A hand up at the head's right, clear of its outline: the hand waves in over the head and back.
    const ax = Math.min(GRID - 2, Math.max(...head.rows.map(([, x, w]) => x + w)) + 1);
    const top = head.top + 1;
    pose.push([ax - 2, head.bottom + 2, 2, 1, arm], [ax, top, 1, head.bottom + 3 - top, arm]);
    if (frame === "raise") pose.push([ax, top - 2, 2, 2, skin]);
    else pose.push([ax, top - 1, 1, 1, arm], [ax - 1, top - 3, 2, 2, skin]);
  } else if (frame === "think" || frame === "think-blink" || frame === "ponder") {
    // A hand under the chin, its forearm up from the right shoulder.
    pose.push([cx + 3, head.bottom + 1, 2, 3, arm], [cx + 1, head.bottom, 3, 2, skin], [cx + 1, head.bottom + 1, 3, 1, shade(skin, 0.15)]);
  }

  const shapes = [...body, ...pixels.map(lean), ...shut.map(lean), ...features.map(lean), ...pose]
    .filter(([x, y, w, h]) => w > 0 && h > 0 && x >= 0 && y >= 0 && x < GRID && y < GRID)
    .map(([x, y, w, h, color]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}"/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}" shape-rendering="crispEdges"><rect width="${GRID}" height="${GRID}" rx="3" fill="${palette.ground}"/>${shapes}</svg>`;
}

const cache = new Map<string, { svg: string }>();

/** The face as an `Icon`'s `icon`, made once per agent and frame. */
export function avatarIcon(agentId: string, frame: AvatarFrame = "rest"): { svg: string } {
  const key = `${agentId}:${dozeCount(frame) > 0 ? "rest" : frame}`;
  let icon = cache.get(key);
  if (icon === undefined) {
    icon = { svg: avatarSvg(agentId, frame) };
    cache.set(key, icon);
  }
  return icon;
}
