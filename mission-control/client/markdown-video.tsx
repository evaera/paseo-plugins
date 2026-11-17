import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { MAX_VIDEO_BYTES, videoChunk, videoRefusal } from "../shared/videos";
import { classifyImage, imageName } from "./image-source";
import { errorText } from "./format";
import { canPlayVideo, videoBlob, videoPlayer, whenNearView } from "./web";
import type { ImageRef } from "./markdown-image";

export function MarkdownVideo({ image, theme, maxHeight, localFiles }: {
  image: ImageRef; theme: PluginTheme; maxHeight: number; localFiles: boolean;
}) {
  const read = useRpc(videoChunk);
  const frame = useRef<View>(null);
  const [near, setNear] = useState(false);
  const [uri, setUri] = useState<string | null>(null);
  const [message, setMessage] = useState("Load video");
  const [failed, setFailed] = useState(false);
  const source = classifyImage(image.src);
  const label = image.alt.trim() || imageName(image.src);
  useEffect(() => {
    if (!canPlayVideo) return;
    return whenNearView(frame.current, () => setNear(true));
  }, [image.src]);
  useEffect(() => {
    let live = true;
    let dispose: (() => void) | undefined;
    setUri(null);
    setFailed(false);
    if (!canPlayVideo || !near) return;
    if (source.kind === "remote") { setUri(source.uri); return; }
    if (source.kind !== "local" || !localFiles) return;
    setMessage("Downloading video: 0%");
    void (async () => {
      const chunks: string[] = [];
      let offset = 0;
      let version: string | null = null;
      while (live) {
        const result = await read({ src: image.src, offset });
        if (!live) return;
        if (result.status === "refused") throw new Error(videoRefusal(result.reason, result.size));
        const current = `${result.size}:${result.modifiedMs}:${result.mimeType}`;
        if (version !== null && version !== current) throw new Error("Video changed during download. Reopen this view to retry.");
        version = current;
        if (result.size > MAX_VIDEO_BYTES) throw new Error(videoRefusal("too-large", result.size));
        const length = result.base64.length * 3 / 4 - (result.base64.endsWith("==") ? 2 : result.base64.endsWith("=") ? 1 : 0);
        if (length <= 0 || offset + length > result.size) throw new Error("Video download was incomplete");
        chunks.push(result.base64);
        offset += length;
        setMessage(`Downloading video: ${Math.round(offset / result.size * 100)}%`);
        if (offset === result.size) {
          const blob = videoBlob(chunks, result.mimeType);
          dispose = blob.dispose;
          setUri(blob.uri);
          return;
        }
      }
    })().catch((error: unknown) => { if (live) { setFailed(true); setMessage(errorText(error)); } });
    return () => { live = false; dispose?.(); };
  }, [image.src, near, localFiles, read]);
  const external = !canPlayVideo && source.kind === "remote" ? source.uri : null;
  const problem = external !== null ? "Open video" : !canPlayVideo ? "Video plays on desktop" : source.kind === "invalid" ? "Invalid video source" : source.kind === "local" && !localFiles ? "Video is on the worker's host, which this view cannot read" : null;
  return <View ref={frame} style={{ gap: 4 }}>
    {problem !== null || uri === null || failed ? (
      <Pressable onPress={() => {
        if (external === null) setNear(true);
        else void openExternalUrl(external).catch((error: unknown) => { setFailed(true); setMessage(errorText(error)); });
      }} accessibilityRole="button" accessibilityLabel={label} style={{ padding: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6 }}>
        <Text style={{ color: theme.colors.foregroundMuted }}>{failed ? message : problem ?? message}</Text>
      </Pressable>
    ) : videoPlayer(uri, label, maxHeight, () => { setFailed(true); setMessage("This video format or codec cannot be played here"); })}
    <Text style={{ color: theme.colors.foregroundMuted }}>{label}</Text>
  </View>;
}
