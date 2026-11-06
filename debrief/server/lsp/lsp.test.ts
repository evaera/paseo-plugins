import { describe, expect, it } from "vitest";

import { answerServerRequest } from "./connection";
import { toCompletions, toHover, toLocations } from "./convert";
import { discoverServer, parseCommandLine } from "./discover";
import { encodeMessage, MessageReader } from "./framing";

describe("framing", () => {
  it("round-trips messages split across and packed into chunks", () => {
    const one = encodeMessage({ jsonrpc: "2.0", id: 1, result: "café" });
    const two = encodeMessage({ jsonrpc: "2.0", method: "x" });
    const all = Buffer.concat([one, two]);
    const reader = new MessageReader();
    const seen: unknown[] = [];
    for (let index = 0; index < all.length; index += 7) seen.push(...reader.push(all.subarray(index, index + 7)));
    expect(seen).toEqual([
      { jsonrpc: "2.0", id: 1, result: "café" },
      { jsonrpc: "2.0", method: "x" },
    ]);
  });

  it("counts Content-Length in bytes, and skips a body that is not JSON", () => {
    const reader = new MessageReader();
    const bad = Buffer.from("Content-Length: 3\r\n\r\n{x}");
    const good = encodeMessage({ ok: "☃" });
    expect(reader.push(Buffer.concat([bad, good]))).toEqual([{ ok: "☃" }]);
  });
});

describe("discovery", () => {
  const executable = (paths: string[]) => async (path: string) => paths.includes(path);

  it("prefers the settings override, then each directory in order", async () => {
    const dirs = ["/mason", "/path", "/project/node_modules/.bin"];
    expect(
      await discoverServer("typescript", { override: "/opt/vtsls --stdio", searchDirs: dirs, isExecutable: executable(["/opt/vtsls", "/mason/vtsls"]) }),
    ).toEqual({ command: "/opt/vtsls", args: ["--stdio"] });
    expect(
      await discoverServer("typescript", {
        override: undefined,
        searchDirs: dirs,
        isExecutable: executable(["/path/vtsls", "/mason/typescript-language-server"]),
      }),
    ).toEqual({ command: "/mason/typescript-language-server", args: ["--stdio"] });
    expect(
      await discoverServer("typescript", { override: undefined, searchDirs: dirs, isExecutable: executable(["/project/node_modules/.bin/vtsls"]) }),
    ).toEqual({ command: "/project/node_modules/.bin/vtsls", args: ["--stdio"] });
    expect(await discoverServer("go", { override: undefined, searchDirs: dirs, isExecutable: executable([]) })).toBeNull();
  });

  it("resolves a bare override through the search directories", async () => {
    expect(await discoverServer("go", { override: "gopls serve", searchDirs: ["/a", "/b"], isExecutable: executable(["/b/gopls"]) })).toEqual({
      command: "/b/gopls",
      args: ["serve"],
    });
    expect(parseCommandLine("   ")).toBeNull();
  });
});

describe("conversion", () => {
  it("reads Location and LocationLink, relative inside the workspace", () => {
    const range = { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } };
    expect(
      toLocations("/ws", [
        { uri: "file:///ws/src/a.ts", range },
        { targetUri: "file:///lib/b.d.ts", targetRange: range, targetSelectionRange: range },
        { uri: "untitled:x", range },
      ]),
    ).toEqual([
      { path: "src/a.ts", insideWorkspace: true, range },
      { path: "/lib/b.d.ts", insideWorkspace: false, range },
    ]);
    expect(toLocations("/ws", null)).toEqual([]);
  });

  it("turns every hover shape into markdown", () => {
    expect(toHover({ contents: { kind: "markdown", value: "**x**" } }).markdown).toBe("**x**");
    expect(toHover({ contents: [{ language: "ts", value: "const a: number" }, "doc"] }).markdown).toBe("```ts\nconst a: number\n```\n\n---\n\ndoc");
    expect(toHover(null)).toEqual({ markdown: null, range: null });
  });

  it("reads completion lists and arrays, with textEdit ranges", () => {
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } };
    expect(toCompletions({ isIncomplete: true, items: [{ label: "foo", kind: 3, textEdit: { newText: "foo()", range } }] })).toEqual({
      isIncomplete: true,
      items: [{ label: "foo", detail: null, kind: 3, insertText: "foo()", range, sortText: null }],
    });
    expect(toCompletions([{ label: "bar", insertText: "baz", sortText: "1" }]).items[0]).toMatchObject({ insertText: "baz", range: null, sortText: "1" });
  });

  it("answers server requests minimally", () => {
    expect(answerServerRequest("workspace/configuration", { items: [{}, {}] })).toEqual([null, null]);
    expect(answerServerRequest("client/registerCapability", {})).toBeNull();
    expect(answerServerRequest("window/workDoneProgress/create", {})).toBeNull();
  });
});
