import { describe, expect, it } from "vitest";

import { isImagePath, joinRelative, localPathOf } from "../shared/local-path";
import { fileCandidates, inlineTokens, lookupIn, pathCandidate, type InlineToken } from "./file-links";
import { classifyImage, fitImage, imageName, refusalText } from "./image-source";
import { inlineTexts, parseMarkdown } from "./markdown-parse";
import { isVideoPath, videoRefusal } from "../shared/videos";

it("uses image syntax for video targets and explains video refusals", () => {
  expect(images(inlineTokens("![demo](tasks/demo.mp4)", lookupIn({})))).toEqual([{ alt: "demo", src: "tasks/demo.mp4" }]);
  expect(["clip.MP4", "clip.webm", "file:///clip.mov", "https://example.com/clip.mp4?token=x"].every(isVideoPath)).toBe(true);
  expect(isVideoPath("clip.png")).toBe(false);
  expect(videoRefusal("too-large", 101 * 1024 * 1024)).toContain("100 MB");
  expect(videoRefusal("unsupported", null)).toContain("MP4, WebM or MOV");
});

const HOME = "C:/Users/eryn/.paseo/plugin-data/mission-control/home";
const none = lookupIn({});

function images(tokens: readonly InlineToken[]): { alt: string; src: string }[] {
  return tokens.flatMap((token) => (token.kind === "image" ? [{ alt: token.alt, src: token.src }] : []));
}

describe("local paths", () => {
  it("reads file URLs, Windows paths either way round, and leaves other schemes out", () => {
    expect(localPathOf("file:///C:/Users/eryn/shot%20one.png")).toBe("C:/Users/eryn/shot one.png");
    expect(localPathOf("file://localhost/Users/eryn/a.png")).toBe("/Users/eryn/a.png");
    expect(localPathOf("file:///Users/eryn/a.png?x=1#frag")).toBe("/Users/eryn/a.png");
    expect(localPathOf("file://server/share/a.png")).toBeNull();
    expect(localPathOf("C:\\Users\\eryn\\a.png")).toBe("C:\\Users\\eryn\\a.png");
    expect(localPathOf("c:/x/a.png")).toBe("c:/x/a.png");
    expect(localPathOf("tasks/x/a.png")).toBe("tasks/x/a.png");
    expect(localPathOf("https://example.com/a.png")).toBeNull();
    expect(localPathOf("javascript:alert(1)")).toBeNull();
    expect(localPathOf("  ")).toBeNull();
  });

  it("joins a relative path to the file's folder without hiding a climb out of the home", () => {
    expect(joinRelative("tasks/x", "shots/a.png")).toBe("tasks/x/shots/a.png");
    expect(joinRelative("tasks/x", "../y/b.png")).toBe("tasks/y/b.png");
    expect(joinRelative("tasks", "../../etc/passwd")).toBe("../etc/passwd");
    expect(joinRelative("tasks", "C:\\abs.png")).toBe("C:\\abs.png");
    expect(joinRelative("", ".\\a\\b.png")).toBe("a/b.png");
  });

  it("knows the four image types by extension", () => {
    expect(["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp"].every(isImagePath)).toBe(true);
    expect(isImagePath("a.svg")).toBe(false);
    expect(isImagePath("png")).toBe(false);
  });
});

describe("Markdown images", () => {
  it("takes the forms an agent writes: home-relative, absolute either slash, file URL, https, data", () => {
    const text = [
      "![red giant](tasks/godot-space-sky/shots/red_giant_sun_rt.png)",
      `![abs](${HOME}/tasks/a.png)`,
      "![back](C:\\Users\\eryn\\Development\\fleetbound-godot\\shots\\b.png)",
      `![url](file:///${HOME}/tasks/c%20d.png)`,
      "![web](https://example.com/e.webp)",
      "![](data:image/png;base64,iVBORw0KGgo=)",
    ].join("\n");
    expect(images(inlineTokens(text, none))).toEqual([
      { alt: "red giant", src: "tasks/godot-space-sky/shots/red_giant_sun_rt.png" },
      { alt: "abs", src: `${HOME}/tasks/a.png` },
      { alt: "back", src: "C:\\Users\\eryn\\Development\\fleetbound-godot\\shots\\b.png" },
      { alt: "url", src: `file:///${HOME}/tasks/c%20d.png` },
      { alt: "web", src: "https://example.com/e.webp" },
      { alt: "", src: "data:image/png;base64,iVBORw0KGgo=" },
    ]);
  });

  it("takes spaces, angle brackets, parentheses and a title in the target", () => {
    expect(images(inlineTokens("![a](C:\\My Shots\\one (2).png)", none))).toEqual([{ alt: "a", src: "C:\\My Shots\\one (2).png" }]);
    expect(images(inlineTokens("![b](<tasks/my shots/b.png>)", none))).toEqual([{ alt: "b", src: "tasks/my shots/b.png" }]);
    expect(images(inlineTokens('![c](tasks/c.png "The caption")', none))).toEqual([{ alt: "c", src: "tasks/c.png" }]);
    expect(images(inlineTokens("![d](tasks/d\\).png)", none))).toEqual([{ alt: "d", src: "tasks/d).png" }]);
  });

  it("joins a relative image to the Markdown file's folder in the Files preview", () => {
    expect(images(inlineTokens("![s](shots/a.png)", none, { baseDir: "tasks/x" }))).toEqual([{ alt: "s", src: "tasks/x/shots/a.png" }]);
    expect(images(inlineTokens("![s](C:/abs/a.png)", none, { baseDir: "tasks/x" }))).toEqual([{ alt: "s", src: "C:/abs/a.png" }]);
  });

  it("leaves an escaped or unclosed image as text", () => {
    expect(inlineTokens("\\![not](a.png)", none).some((token) => token.kind === "image")).toBe(false);
    expect(inlineTokens("![open](a.png", none)).toEqual([{ kind: "text", text: "![open](a.png", bold: false }]);
    expect(inlineTokens("`![code](a.png)`", none)).toEqual([{ kind: "code", text: "![code](a.png)", bold: false }]);
  });

  it("finds images in list items and table cells, and none in a fenced block", () => {
    const blocks = parseMarkdown(
      [
        "- first ![one](tasks/1.png)",
        "- ![two](tasks/2.png)",
        "",
        "| Shot | Note |",
        "| --- | --- |",
        "| ![three](tasks/3.png) | a \\| b |",
        "",
        "```",
        "![four](tasks/4.png)",
        "```",
      ].join("\n"),
    );
    const found = inlineTexts(blocks).flatMap((text) => images(inlineTokens(text, none)).map((image) => image.alt));
    expect(found).toEqual(["one", "two", "three"]);
  });
});

describe("Markdown links", () => {
  const lookup = lookupIn(
    {
      "tasks/x/report.md": "tasks/x/report.md",
      [`${HOME}/state/backlog.md`]: "state/backlog.md",
      "C:\\Users\\eryn\\.paseo\\plugin-data\\mission-control\\home\\AGENTS.md": "AGENTS.md",
    },
    {
      "C:/Users/eryn/Development/fleetbound-godot/docs/space sky.md": "C:\\Users\\eryn\\Development\\fleetbound-godot\\docs\\space sky.md",
      "C:\\Users\\eryn\\Development\\fleetbound-godot\\src\\main.gd": "C:\\Users\\eryn\\Development\\fleetbound-godot\\src\\main.gd",
    },
  );

  it("takes Windows paths, file URLs and a trailing line as candidates", () => {
    expect(pathCandidate("C:\\Users\\eryn\\notes.md")).toBe("C:\\Users\\eryn\\notes.md");
    expect(pathCandidate("C:\\Users\\eryn\\src\\main.gd:42")).toBe("C:\\Users\\eryn\\src\\main.gd");
    expect(pathCandidate("C:\\Users\\eryn\\shots")).toBe("C:\\Users\\eryn\\shots");
    expect(pathCandidate("file:///C:/a%20b/c.md")).toBeNull();
    expect(pathCandidate("file:///C:/a%20b/c.md", true)).toBe("C:/a b/c.md");
    expect(pathCandidate("tasks/x/report.md#L12-L20")).toBe("tasks/x/report.md");
    expect(pathCandidate("AGENTS.md:12")).toBe("AGENTS.md");
    expect(pathCandidate("notes.md:12:4", true)).toBe("notes.md");
    expect(pathCandidate("mailto:a@b.c")).toBeNull();
  });

  it("opens a link to a home file in Files and a project file in the file manager", () => {
    expect(inlineTokens("[the report](tasks/x/report.md)", lookup)).toEqual([
      { kind: "file", text: "the report", path: "tasks/x/report.md", where: "home", bold: false, code: false },
    ]);
    expect(inlineTokens("[doc](file:///C:/Users/eryn/Development/fleetbound-godot/docs/space%20sky.md)", lookup)).toEqual([
      {
        kind: "file",
        text: "doc",
        path: "C:\\Users\\eryn\\Development\\fleetbound-godot\\docs\\space sky.md",
        where: "project",
        bold: false,
        code: false,
      },
    ]);
    expect(inlineTokens("see C:\\Users\\eryn\\Development\\fleetbound-godot\\src\\main.gd:42.", lookup)).toEqual([
      { kind: "text", text: "see ", bold: false },
      {
        kind: "file",
        text: "C:\\Users\\eryn\\Development\\fleetbound-godot\\src\\main.gd:42",
        path: "C:\\Users\\eryn\\Development\\fleetbound-godot\\src\\main.gd",
        where: "project",
        bold: false,
        code: false,
      },
      { kind: "text", text: ".", bold: false },
    ]);
    expect(inlineTokens("`C:\\Users\\eryn\\.paseo\\plugin-data\\mission-control\\home\\AGENTS.md`", lookup)).toEqual([
      {
        kind: "file",
        text: "C:\\Users\\eryn\\.paseo\\plugin-data\\mission-control\\home\\AGENTS.md",
        path: "AGENTS.md",
        where: "home",
        bold: false,
        code: true,
      },
    ]);
  });

  it("keeps a URL's balanced parentheses, in a link and bare, and leaves the sentence's off", () => {
    expect(inlineTokens("[Foo](https://en.wikipedia.org/wiki/Foo_(bar))", none)).toEqual([
      { kind: "link", text: "Foo", url: "https://en.wikipedia.org/wiki/Foo_(bar)", bold: false, code: false },
    ]);
    expect(inlineTokens("(see https://en.wikipedia.org/wiki/Foo_(bar)).", none)).toEqual([
      { kind: "text", text: "(see ", bold: false },
      { kind: "link", text: "https://en.wikipedia.org/wiki/Foo_(bar)", url: "https://en.wikipedia.org/wiki/Foo_(bar)", bold: false, code: false },
      { kind: "text", text: ").", bold: false },
    ]);
    expect(inlineTokens("<https://paseo.sh/docs>", none)).toEqual([
      { kind: "link", text: "https://paseo.sh/docs", url: "https://paseo.sh/docs", bold: false, code: false },
    ]);
  });

  it("links inside bold, keeps a code label's look, and follows no script URL", () => {
    expect(inlineTokens("**[Superhive](https://superhivemarket.com/x)**", none)).toEqual([
      { kind: "link", text: "Superhive", url: "https://superhivemarket.com/x", bold: true, code: false },
    ]);
    expect(inlineTokens("[`report.md`](tasks/x/report.md)", lookup)).toEqual([
      { kind: "file", text: "report.md", path: "tasks/x/report.md", where: "home", bold: false, code: true },
    ]);
    expect(inlineTokens("[x](javascript:alert(1))", none)).toEqual([{ kind: "text", text: "x", bold: false }]);
    expect(inlineTokens("[x](vscode://file/C:/a.ts)", none)).toEqual([
      { kind: "link", text: "x", url: "vscode://file/C:/a.ts", bold: false, code: false },
    ]);
  });

  it("draws a link to a file the daemon did not vouch for as its text, not a dead link", () => {
    expect(inlineTokens("[gone](tasks/missing.md)", lookup)).toEqual([{ kind: "text", text: "gone", bold: false }]);
    expect(inlineTokens("[top](#heading)", lookup)).toEqual([{ kind: "text", text: "top", bold: false }]);
  });

  it("honours escapes but keeps every character of a Windows path in prose", () => {
    expect(inlineTokens("\\[not a link\\](x) and \\*not bold\\*", none).map((token) => ("text" in token ? token.text : "")).join("")).toBe(
      "[not a link](x) and *not bold*",
    );
    const prose = inlineTokens("C:\\Users\\eryn\\.paseo\\x", none);
    expect(prose.map((token) => ("text" in token ? token.text : "")).join("")).toBe("C:\\Users\\eryn\\.paseo\\x");
    expect(inlineTokens("snake__case__name", none)).toEqual([{ kind: "text", text: "snake__case__name", bold: false }]);
  });

  it("walks a real reply: a table of backticked names, three images on their own lines, links in bold", () => {
    const reply = [
      "**Open the folder:** `explorer.exe \"C:\\Users\\eryn\\.paseo\\plugin-data\\mission-control\\home\\tasks\\godot-space-sky\\shots\"`.",
      "",
      "| File | What you'll see |",
      "| --- | --- |",
      "| `red_giant_sun_rt.png` | The local sun, the galactic band and a ringed giant together. |",
      "| [SciFi Kit](https://superhivemarket.com/products/scifi-industrial-modular-kit) (Superhive) | $34.99 |",
      "",
      `![red giant](file:///${HOME}/tasks/godot-space-sky/shots/red_giant_sun_rt.png)`,
      `![planet limb](file:///${HOME}/tasks/godot-space-sky/shots/ocean_world_planet_limb_rt.png)`,
      `![ring window](file:///${HOME}/tasks/godot-space-sky/shots/world_ring_view_rt.png)`,
      "",
      "- **Best buy:** the [SciFi Industrial Modular Kit](https://superhivemarket.com/products/scifi-industrial-modular-kit) on Superhive.",
    ].join("\n");
    const blocks = parseMarkdown(reply);
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "table", "paragraph", "list"]);
    const gallery = blocks[2];
    const tokens = gallery?.kind === "paragraph" ? inlineTokens(gallery.text, none) : [];
    expect(images(tokens).map((image) => image.alt)).toEqual(["red giant", "planet limb", "ring window"]);
    // Only the line breaks between them are left, which the renderer drops.
    expect(tokens.filter((token) => token.kind !== "image").every((token) => token.kind === "text" && token.text.trim() === "")).toBe(true);
    const table = blocks[1];
    const cell = table?.kind === "table" ? (table.rows[1]?.[0] ?? "") : "";
    expect(inlineTokens(cell, none)[0]).toEqual({
      kind: "link",
      text: "SciFi Kit",
      url: "https://superhivemarket.com/products/scifi-industrial-modular-kit",
      bold: false,
      code: false,
    });
    expect(fileCandidates(reply)).not.toContain(`${HOME}/tasks/godot-space-sky/shots/red_giant_sun_rt.png`);
  });
});

describe("image sources", () => {
  it("loads http(s) and data images in the app and local ones through the daemon", () => {
    expect(classifyImage("https://x.dev/a.png")).toEqual({ kind: "remote", uri: "https://x.dev/a.png" });
    expect(classifyImage("data:image/webp;base64,AAAA")).toEqual({ kind: "remote", uri: "data:image/webp;base64,AAAA" });
    expect(classifyImage("data:text/html;base64,AAAA")).toEqual({ kind: "invalid" });
    expect(classifyImage("tasks/a.png")).toEqual({ kind: "local", src: "tasks/a.png" });
    expect(classifyImage("file:///C:/a.png")).toEqual({ kind: "local", src: "file:///C:/a.png" });
    expect(classifyImage("ftp://x/a.png")).toEqual({ kind: "invalid" });
  });

  it("names the file in a placeholder", () => {
    expect(imageName("file:///C:/My%20Shots/a%20b.png")).toBe("a b.png");
    expect(imageName("C:\\x\\y.png")).toBe("y.png");
    expect(refusalText("too-large", "tasks/big.png", 12 * 1024 * 1024)).toBe(
      "big.png is 12.0 MB, over the 8.0 MB limit for images in the chat",
    );
    expect(refusalText("outside", "C:/Windows/x.png", null)).toMatch(/outside Mission Control's home and Paseo's projects/);
  });

  it("fits the column, caps the height, keeps the shape and never enlarges", () => {
    expect(fitImage({ width: 1920, height: 1080 }, 600, 360)).toEqual({ width: 600, height: 338 });
    expect(fitImage({ width: 1920, height: 1080 }, 1200, 360)).toEqual({ width: 640, height: 360 });
    expect(fitImage({ width: 64, height: 64 }, 600, 360)).toEqual({ width: 64, height: 64 });
    expect(fitImage({ width: null, height: null }, 320, 360)).toEqual({ width: 320, height: 180 });
  });
});
