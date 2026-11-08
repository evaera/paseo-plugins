import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MAX_IMAGE_BYTES } from "../shared/files";
import { readImageHeader } from "./image-header";
import { findLinkedFiles, readLocalImage, resolveLocalFile, revealCommand } from "./local-files";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A 1×1 PNG's first bytes: signature, then IHDR with width and height. */
function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

/** A home with an image, a note and a folder; a project beside it; and a secret outside both. */
async function layout() {
  const home = await temp("mission-control-home-");
  const project = await temp("mission-control-project-");
  const outside = await temp("mission-control-outside-");
  await mkdir(join(home, "tasks", "x", "shots"), { recursive: true });
  await writeFile(join(home, "tasks", "x", "shots", "a.png"), png(1920, 1080));
  await writeFile(join(home, "tasks", "x", "notes.md"), "notes");
  await mkdir(join(project, "docs", "my shots"), { recursive: true });
  await writeFile(join(project, "docs", "my shots", "b c.png"), png(64, 32));
  await writeFile(join(project, "docs", "fake.png"), "<html>not an image</html>");
  await writeFile(join(outside, "secret.png"), png(1, 1));
  return { home, project, outside, roots: [project] };
}

describe("resolveLocalFile", () => {
  it("finds a home file by relative path, absolute path either slash, and file URL", async () => {
    const { home, roots } = await layout();
    const forward = home.replace(/\\/g, "/");
    for (const source of [
      "tasks/x/shots/a.png",
      "tasks\\x\\shots\\a.png",
      join(home, "tasks", "x", "shots", "a.png"),
      `${forward}/tasks/x/shots/a.png`,
      `file:///${forward.replace(/^\//, "")}/tasks/x/shots/a.png`,
    ]) {
      const target = await resolveLocalFile(home, roots, source);
      expect(target, source).toMatchObject({ kind: "home", relative: "tasks/x/shots/a.png" });
    }
  });

  it("finds a project file by absolute path, spaces and percent-escapes included", async () => {
    const { home, project, roots } = await layout();
    const forward = project.replace(/\\/g, "/");
    for (const source of [
      join(project, "docs", "my shots", "b c.png"),
      `${forward}/docs/my shots/b c.png`,
      `file:///${forward.replace(/^\//, "")}/docs/my%20shots/b%20c.png`,
    ]) {
      expect(await resolveLocalFile(home, roots, source), source).toMatchObject({ kind: "project", root: project });
    }
  });

  it("refuses traversal out of the home and out of a project, and anything outside every root", async () => {
    const { home, project, outside, roots } = await layout();
    const outsideName = outside.split(/[\\/]/).pop() ?? "";
    for (const source of [
      "../secret.png",
      "tasks/../../secret.png",
      `tasks/../../${outsideName}/secret.png`,
      join(outside, "secret.png"),
      `${home}/../${outsideName}/secret.png`,
      `${project}/docs/../../${outsideName}/secret.png`,
      `file:///${join(outside, "secret.png").replace(/\\/g, "/").replace(/^\//, "")}`,
    ]) {
      expect(await resolveLocalFile(home, roots, source), source).toEqual({ refused: "outside" });
    }
    // Without the project registered, its files are outside too.
    expect(await resolveLocalFile(home, [], join(project, "docs", "fake.png"))).toEqual({ refused: "outside" });
  });

  it("refuses a symlink in the home or a project that points outside", async () => {
    const { home, project, outside, roots } = await layout();
    await symlink(join(outside, "secret.png"), join(home, "tasks", "link.png"));
    await symlink(outside, join(project, "elsewhere"), "junction");
    expect(await resolveLocalFile(home, roots, "tasks/link.png")).toEqual({ refused: "outside" });
    expect(await resolveLocalFile(home, roots, join(project, "elsewhere", "secret.png"))).toEqual({ refused: "outside" });
  });

  it("tells a missing file and a folder apart from a refusal, and refuses other schemes", async () => {
    const { home, project, roots } = await layout();
    expect(await resolveLocalFile(home, roots, "tasks/x/none.png")).toEqual({ refused: "missing" });
    expect(await resolveLocalFile(home, roots, join(project, "none.png"))).toEqual({ refused: "missing" });
    expect(await resolveLocalFile(home, roots, "tasks/x")).toEqual({ refused: "not-a-file" });
    expect(await resolveLocalFile(home, roots, join(project, "docs"))).toEqual({ refused: "not-a-file" });
    expect(await resolveLocalFile(home, roots, "https://example.com/a.png")).toEqual({ refused: "unsupported" });
  });
});

describe("findLinkedFiles", () => {
  it("maps home files to their home path and project files to their absolute path, and leaves the rest out", async () => {
    const { home, project, outside, roots } = await layout();
    const projectFile = join(project, "docs", "fake.png");
    const found = await findLinkedFiles(home, roots, [
      "tasks/x/notes.md",
      join(home, "tasks", "x", "notes.md"),
      projectFile,
      join(outside, "secret.png"),
      "../secret.png",
      "tasks/x",
      "tasks/none.md",
    ]);
    expect(found.files).toEqual({ "tasks/x/notes.md": "tasks/x/notes.md", [join(home, "tasks", "x", "notes.md")]: "tasks/x/notes.md" });
    expect(Object.keys(found.projectFiles)).toEqual([projectFile]);
  });
});

describe("readLocalImage", () => {
  it("sends an image's bytes with the type and size its header gives", async () => {
    const { home, project, roots } = await layout();
    const result = await readLocalImage(home, roots, "tasks/x/shots/a.png");
    expect(result).toMatchObject({ status: "ok", mimeType: "image/png", width: 1920, height: 1080, size: 33 });
    expect(result.status === "ok" ? Buffer.from(result.base64, "base64").length : 0).toBe(33);
    expect(await readLocalImage(home, roots, join(project, "docs", "my shots", "b c.png"))).toMatchObject({ width: 64, height: 32 });
  });

  it("refuses a file that is not an image whatever its name, one too large, and one outside", async () => {
    const { home, project, outside, roots } = await layout();
    expect(await readLocalImage(home, roots, join(project, "docs", "fake.png"))).toEqual({ status: "refused", reason: "unsupported", size: 25 });
    await writeFile(join(home, "big.png"), Buffer.concat([png(1, 1), Buffer.alloc(MAX_IMAGE_BYTES)]));
    expect(await readLocalImage(home, roots, "big.png")).toEqual({ status: "refused", reason: "too-large", size: MAX_IMAGE_BYTES + 33 });
    expect(await readLocalImage(home, roots, join(outside, "secret.png"))).toEqual({ status: "refused", reason: "outside", size: null });
  });
});

describe("readImageHeader", () => {
  it("reads PNG, GIF, JPEG and the three WebP chunk kinds, and refuses anything else", () => {
    expect(readImageHeader(png(800, 600))).toEqual({ mimeType: "image/png", width: 800, height: 600 });
    const gif = Buffer.from("GIF89a\x40\x01\xf0\x00", "latin1");
    expect(readImageHeader(gif)).toEqual({ mimeType: "image/gif", width: 320, height: 240 });
    // SOI, an APP0 segment of 16 bytes, then SOF0 with height 1080 and width 1920.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Array(14).fill(0), 0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x38, 0x07, 0x80, 0x03]);
    expect(readImageHeader(jpeg)).toEqual({ mimeType: "image/jpeg", width: 1920, height: 1080 });
    const webp = (chunk: string, body: number[]) =>
      Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBP", "latin1"), Buffer.from(chunk, "latin1"), Buffer.alloc(4), Buffer.from(body)]);
    expect(readImageHeader(webp("VP8X", [0, 0, 0, 0, 0x7f, 0x07, 0x00, 0x37, 0x04, 0x00]))).toEqual({
      mimeType: "image/webp",
      width: 1920,
      height: 1080,
    });
    // VP8L: signature 0x2f, then width-1 = 99 and height-1 = 49 in 14 bits each.
    const vp8l = 99 | (49 << 14);
    expect(readImageHeader(webp("VP8L", [0x2f, vp8l & 0xff, (vp8l >> 8) & 0xff, (vp8l >> 16) & 0xff, (vp8l >> 24) & 0xff]))).toEqual({
      mimeType: "image/webp",
      width: 100,
      height: 50,
    });
    expect(readImageHeader(webp("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01]))).toEqual({
      mimeType: "image/webp",
      width: 640,
      height: 480,
    });
    expect(readImageHeader(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
  });
});

describe("revealCommand", () => {
  it("selects the file in Explorer, Finder, or opens its folder elsewhere", () => {
    expect(revealCommand("win32", "C:\\a b\\c.md")).toEqual({ command: "explorer.exe", args: ['/select,"C:\\a b\\c.md"'], verbatim: true });
    expect(revealCommand("darwin", "/a b/c.md")).toEqual({ command: "open", args: ["-R", "/a b/c.md"], verbatim: false });
    expect(revealCommand("linux", "/a/b/c.md")).toMatchObject({ command: "xdg-open", verbatim: false });
  });
});
