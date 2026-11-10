import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isImageMessageId } from "../shared/attachments";
import { chatImageSources, keepChatImages, newImageMessageId } from "./chat-images";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mission-control-chat-images-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const png = Buffer.from("png bytes").toString("base64");
const jpeg = Buffer.from("jpeg bytes").toString("base64");

describe("the chat's sent images", () => {
  it("keeps a message's images in the home, in the order attached, under an id only the plugin makes", async () => {
    const id = newImageMessageId();
    expect(isImageMessageId(id)).toBe(true);
    await keepChatImages(home, id, [
      { data: png, mimeType: "image/png" },
      { data: jpeg, mimeType: "image/jpeg; charset=binary" },
      { data: png, mimeType: "image/x-unknown" },
    ]);
    const sources = await chatImageSources(home, id);
    expect(sources).toEqual([`.attachments/${id}/00.png`, `.attachments/${id}/01.jpg`, `.attachments/${id}/02.img`]);
    expect((await readFile(join(home, sources[1] ?? ""))).toString()).toBe("jpeg bytes");
  });

  it("answers with nothing for a message it kept nothing for", async () => {
    expect(await chatImageSources(home, newImageMessageId())).toEqual([]);
  });

  it("never takes an id that could name another folder", async () => {
    for (const id of ["../x", "mission-control-images-../../x", "mission-control-watch-1", "mission-control-images-"]) {
      expect(isImageMessageId(id)).toBe(false);
      expect(await chatImageSources(home, id)).toEqual([]);
      await expect(keepChatImages(home, id, [{ data: png, mimeType: "image/png" }])).rejects.toThrow();
    }
  });
});
