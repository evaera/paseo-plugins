import { findSvgIconProblem } from "@getpaseo/plugin";
import { describe, expect, it } from "vitest";

import { avatarFrame, avatarIcon, avatarMood, avatarSvg, dozeCount, lightness, shade, type AvatarMood } from "./avatar";
import { modelName } from "./format";
import { workerState } from "./worker-state";

const ids = Array.from({ length: 200 }, (_, index) => `0b6f${index.toString(16).padStart(4, "0")}-1c2d-4e5f-8a9b-${index}`);

describe("a worker's face", () => {
  it("is the same face for the same agent, every time", () => {
    expect(avatarSvg("4f1c2a90-5b7d-4e3a-9c21-8d6e0f3b7a15")).toBe(avatarSvg("4f1c2a90-5b7d-4e3a-9c21-8d6e0f3b7a15"));
    expect(avatarIcon("a1")).toBe(avatarIcon("a1"));
  });

  it("is SVG Paseo draws: rects only, no style, under the size cap", () => {
    ids.slice(0, 40).forEach((id) => {
      const svg = avatarSvg(id);
      expect(findSvgIconProblem(svg)).toBeNull();
      expect(svg).not.toMatch(/<(style|path|image|use)\b/);
    });
  });

  it("gives nearly every agent a face of its own", () => {
    expect(new Set(ids.map((id) => avatarSvg(id))).size).toBeGreaterThan(195);
  });

  it("darkens a colour and reads its lightness", () => {
    expect(shade("#ffffff", 0.5)).toBe("#808080");
    expect(lightness("#ffffff")).toBeCloseTo(1);
    expect(lightness("#000000")).toBe(0);
  });
});

describe("a worker's model as people say it", () => {
  it("names Claude and GPT models, and leaves the rest as Paseo has them", () => {
    expect(modelName({ provider: "claude", model: "claude-opus-5-5" })).toBe("Opus 5.5");
    expect(modelName({ provider: "claude", model: "claude-haiku-4-5-20251001" })).toBe("Haiku 4.5");
    expect(modelName({ provider: "claude", model: "claude-sonnet-5" })).toBe("Sonnet 5");
    expect(modelName({ provider: "codex", model: "gpt-5.5" })).toBe("GPT-5.5");
    expect(modelName({ provider: "opencode", model: null })).toBe("opencode");
  });
});

describe("where a worker stands", () => {
  const agent = (overrides: Partial<{ status: "running" | "idle" | "error" | "initializing" | "closed"; pendingPermissions: number; requiresAttention: boolean }>) => ({
    status: "idle" as const,
    pendingPermissions: 0,
    requiresAttention: false,
    ...overrides,
  });
  it("lets Paseo's state win while the worker is busy or stuck, then its status line", () => {
    expect(workerState(agent({ status: "error" }), { state: "done", text: "" }).label).toBe("Error");
    expect(workerState(agent({ pendingPermissions: 1 }), null).label).toBe("Needs you");
    expect(workerState(agent({ status: "running" }), { state: "done", text: "" }).label).toBe("Working");
    expect(workerState(agent({}), { state: "done", text: "" })).toMatchObject({ label: "Done", tone: "accent" });
    expect(workerState(agent({}), { state: "blocked", text: "" }).tone).toBe("warning");
    expect(workerState(agent({}), null).label).toBe("Idle");
    // Paseo's "finished, not looked at yet" is not the user being needed.
    const flagged = { ...agent({}), requiresAttention: true };
    expect(workerState(flagged, null).label).toBe("Idle");
  });

  it("strikes a pose in every frame, each a drawing Paseo accepts", () => {
    const frames = ["raise", "wave", "think", "think-blink", "ponder"] as const;
    ids.slice(0, 40).forEach((id) =>
      frames.forEach((frame) => {
        const svg = avatarSvg(id, frame);
        expect(findSvgIconProblem(svg)).toBeNull();
        expect(svg).not.toBe(avatarSvg(id));
      }),
    );
  });

  it("loops each mood's frames, out of step from one worker to the next", () => {
    const frames = (mood: AvatarMood, id: string) => Array.from({ length: 20 }, (_, tick) => avatarFrame(mood, tick, id));
    expect(new Set(frames("needs", "a"))).toEqual(new Set(["raise", "wave"]));
    expect(new Set(frames("working", "a"))).toEqual(new Set(["think", "think-blink", "ponder"]));
    expect(new Set(frames("rest", "a"))).toEqual(new Set(["rest"]));
    expect(new Set(frames("waiting", "a").map(dozeCount))).toEqual(new Set([1, 2, 3]));
    expect(avatarIcon("a", "doze-2")).toBe(avatarIcon("a"));
    expect(ids.slice(0, 20).map((id) => avatarFrame("needs", 0, id))).toContain("wave");
  });

  it("waves for the user, thinks while working, and is still otherwise", () => {
    const agent = (status: string, pendingPermissions = 0) => ({ status, pendingPermissions }) as Parameters<typeof avatarMood>[0];
    expect(avatarMood(agent("idle", 1))).toBe("needs");
    expect(avatarMood(agent("idle"), "blocked")).toBe("needs");
    expect(avatarMood(agent("running"))).toBe("working");
    expect(avatarMood(agent("running"), "working")).toBe("working");
    expect(avatarMood(agent("idle"), "idle")).toBe("rest");
    expect(avatarMood(agent("idle"), "waiting")).toBe("waiting");
    expect(avatarMood(agent("error", 1), "blocked")).toBe("rest");
  });
});
