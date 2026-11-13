import { afterEach, expect, it, vi } from "vitest";
vi.mock("react-native", () => ({ Platform: { OS: "web" } }));
import { videoBlob, videoPlayer } from "./web";

afterEach(() => vi.unstubAllGlobals());
it("builds a typed Blob from chunks and provides URL cleanup", () => {
  let captured: Blob | undefined;
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: (blob: Blob) => { captured = blob; return "blob:video"; }, revokeObjectURL });
  const resource = videoBlob(["YWJj", "ZA=="], "video/mp4");
  expect(captured?.size).toBe(4);
  expect(captured?.type).toBe("video/mp4");
  expect(resource.uri).toBe("blob:video");
  resource.dispose();
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:video");
});
it("renders the accessible browser player with controls and metadata preload", () => {
  const player = videoPlayer("blob:video", "Demo", 320, () => {});
  expect(player?.type).toBe("video");
  expect(player?.props).toMatchObject({ src: "blob:video", "aria-label": "Demo", controls: true, muted: true, playsInline: true, preload: "metadata", style: { maxHeight: 320 } });
});
