/**
 * A Markdown image, drawn: an `https://` or `data:` image loaded by the app, or a file on the
 * daemon's machine sent base64 by `mission-control.files.image`, which decides what may be read
 * (the home and registered project roots only, `server/local-files.ts`).
 *
 * A local image is fetched only once it scrolls near the view (`whenNearView`), two at a time
 * across the plugin, and kept in the query cache for five minutes, so a chat of screenshots neither
 * fetches every one on mount nor fetches one again on every remount. Pressing an image opens it
 * full size in a host `Modal`.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Image, Pressable, Text, View, useWindowDimensions } from "react-native";

import { readImage } from "../shared/files";
import { errorText } from "./format";
import { classifyImage, fitImage, imageName, refusalText } from "./image-source";
import { FONT_SIZE, lineHeightFor } from "./type-scale";
import { whenNearView } from "./web";

export interface ImageRef {
  alt: string;
  src: string;
}

/** How many local images are read at once, across every chat and transcript. */
const PARALLEL_READS = 2;
let reading = 0;
const queued: (() => void)[] = [];

async function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  if (reading >= PARALLEL_READS) await new Promise<void>((start) => queued.push(start));
  reading += 1;
  try {
    return await task();
  } finally {
    reading -= 1;
    queued.shift()?.();
  }
}

/** Sources already drawn once in this evaluation of the bundle, which skip the wait for the view. */
const seenSources = new Set<string>();

type Loaded =
  | { state: "loading" }
  | { state: "ok"; uri: string; width: number | null; height: number | null }
  | { state: "refused"; text: string };

/** A local image's data URI, or why there is none. */
function useLocalImage(src: string, enabled: boolean): Loaded {
  const read = useRpc(readImage);
  const query = useQuery({
    queryKey: ["mission-control", "image", src],
    queryFn: () =>
      oneAtATime(async function () {
        const result = await read({ src });
        if (result.status === "refused") return { state: "refused" as const, text: refusalText(result.reason, src, result.size) };
        return {
          state: "ok" as const,
          uri: `data:${result.mimeType};base64,${result.base64}`,
          width: result.width,
          height: result.height,
        };
      }),
    enabled,
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  if (query.data !== undefined) return query.data;
  if (query.error !== null) return { state: "refused", text: `${imageName(src)}: ${errorText(query.error)}` };
  return { state: "loading" };
}

/** A remote image's size, from the app's own loader; null dimensions until it answers. */
function useRemoteSize(uri: string | null): { width: number | null; height: number | null; failed: boolean } {
  const [size, setSize] = useState<{ width: number | null; height: number | null; failed: boolean }>({
    width: null,
    height: null,
    failed: false,
  });
  useEffect(() => {
    if (uri === null) return;
    let live = true;
    Image.getSize(
      uri,
      (width, height) => {
        if (live) setSize({ width, height, failed: false });
      },
      () => {
        if (live) setSize({ width: null, height: null, failed: true });
      },
    );
    return () => {
      live = false;
    };
  }, [uri]);
  return size;
}

function Placeholder({ theme, text, icon, height }: { theme: PluginTheme; text: string; icon: string; height?: number }) {
  const { colors } = theme;
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={text}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        borderWidth: 1,
        borderColor: colors.border,
        borderStyle: "dashed",
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        backgroundColor: colors.surface1,
        ...(height === undefined ? {} : { height, justifyContent: "center" as const }),
      }}
    >
      {/* Its own view, or a sentence long enough to wrap squeezes the icon to nothing. */}
      <View style={{ flexShrink: 0 }}>
        <Icon name={icon} size={14} color={colors.foregroundMuted} />
      </View>
      <Text style={{ flexShrink: 1, color: colors.foregroundMuted, fontSize: FONT_SIZE.small, lineHeight: lineHeightFor(FONT_SIZE.small) }}>
        {text}
      </Text>
    </View>
  );
}

/** Alt text worth printing under the image; Paseo's own attachments all say "Image", which is not. */
function caption(alt: string): string | null {
  const trimmed = alt.trim();
  return trimmed === "" || /^(image|screenshot|img)$/i.test(trimmed) ? null : trimmed;
}

function FullSize({
  theme,
  image,
  uri,
  natural,
  remote,
  onClose,
}: {
  theme: PluginTheme;
  image: ImageRef;
  uri: string;
  natural: { width: number | null; height: number | null };
  remote: boolean;
  onClose: () => void;
}) {
  const window = useWindowDimensions();
  const toast = useToast();
  const [width, setWidth] = useState(0);
  const fitted = fitImage(natural, width, Math.max(200, window.height * 0.72));
  const title = caption(image.alt) ?? imageName(image.src);
  return (
    <Modal title={title} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content contentContainerStyle={{ gap: 12 }}>
        <View style={{ alignItems: "center" }} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
          {width === 0 ? null : (
            <Image
              source={{ uri }}
              accessibilityLabel={image.alt || imageName(image.src)}
              resizeMode="contain"
              style={{ width: fitted.width, height: fitted.height, borderRadius: 6 }}
            />
          )}
        </View>
        <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: FONT_SIZE.caption }}>
          {remote ? image.src : `${image.src}${natural.width === null ? "" : ` · ${natural.width}×${natural.height ?? "?"}`}`}
        </Text>
        {remote && /^https?:/i.test(image.src) ? (
          <Pressable
            accessibilityRole="link"
            onPress={() => void openExternalUrl(image.src).catch((caught: unknown) => toast.error(errorText(caught)))}
          >
            <Text style={{ color: theme.colors.accent, fontSize: FONT_SIZE.small }}>Open in the browser</Text>
          </Pressable>
        ) : null}
      </Modal.Content>
    </Modal>
  );
}

/**
 * One image at the width it is given, at most `maxHeight` tall, with its alt text as caption and
 * accessibility label. `localFiles` false (a worker on another host) draws a local source as a
 * placeholder, since this host's daemon cannot read that machine's files.
 */
export function MarkdownImage({
  image,
  theme,
  maxHeight,
  localFiles = true,
}: {
  image: ImageRef;
  theme: PluginTheme;
  maxHeight: number;
  localFiles?: boolean;
}) {
  const source = useMemo(() => classifyImage(image.src), [image.src]);
  const frame = useRef<View>(null);
  const [width, setWidth] = useState(0);
  const [near, setNear] = useState(() => seenSources.has(image.src));
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);
  const local = source.kind === "local" && localFiles;

  useEffect(() => {
    if (near || !local) return;
    return whenNearView(frame.current, () => setNear(true));
  }, [near, local]);

  const loaded = useLocalImage(image.src, local && near);
  const remote = useRemoteSize(source.kind === "remote" ? source.uri : null);

  let body: ReactNode;
  let uri: string | null = null;
  let natural: { width: number | null; height: number | null } = { width: null, height: null };
  if (source.kind === "invalid") {
    body = <Placeholder theme={theme} icon="ImageOff" text={refusalText("invalid", image.src, null)} />;
  } else if (source.kind === "local" && !localFiles) {
    body = <Placeholder theme={theme} icon="ImageOff" text={refusalText("other-host", image.src, null)} />;
  } else if (source.kind === "remote" ? remote.failed || broken : broken) {
    body = <Placeholder theme={theme} icon="ImageOff" text={refusalText("failed", image.src, null)} />;
  } else if (source.kind === "local" && loaded.state === "refused") {
    body = <Placeholder theme={theme} icon="ImageOff" text={loaded.text} />;
  } else if (source.kind === "local" && loaded.state !== "ok") {
    body = <Placeholder theme={theme} icon="Image" text={`Loading ${imageName(image.src)}…`} height={Math.min(maxHeight, 120)} />;
  } else {
    uri = source.kind === "remote" ? source.uri : loaded.state === "ok" ? loaded.uri : null;
    natural = source.kind === "remote" ? remote : loaded.state === "ok" ? loaded : natural;
    const fitted = fitImage(natural, width, maxHeight);
    seenSources.add(image.src);
    body =
      uri === null || width === 0 ? null : (
        <Pressable
          accessibilityRole="imagebutton"
          accessibilityLabel={image.alt.trim() === "" ? imageName(image.src) : image.alt}
          accessibilityHint="Opens the image full size"
          onPress={() => setOpen(true)}
          style={{ width: fitted.width }}
        >
          <Image
            source={{ uri }}
            resizeMode="contain"
            onError={() => setBroken(true)}
            style={{
              width: fitted.width,
              height: fitted.height,
              borderRadius: 6,
              backgroundColor: theme.colors.surface2,
            }}
          />
        </Pressable>
      );
  }

  const text = caption(image.alt);
  return (
    <View ref={frame} style={{ alignSelf: "stretch", gap: 4 }} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {body}
      {text === null || uri === null ? null : (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT_SIZE.caption }} numberOfLines={2}>
          {text}
        </Text>
      )}
      {open && uri !== null ? (
        <FullSize
          theme={theme}
          image={image}
          uri={uri}
          natural={natural}
          remote={source.kind === "remote"}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </View>
  );
}

/**
 * The images of one paragraph, list item or table cell. One is drawn at the column's width; two or
 * more wrap as a grid of tiles at least `tileMin` wide, each shorter, so three screenshots in a row
 * read as a set rather than a long scroll.
 */
export function ImageGallery({
  images,
  theme,
  maxHeight,
  tileMin = 220,
  localFiles = true,
}: {
  images: readonly ImageRef[];
  theme: PluginTheme;
  maxHeight: number;
  tileMin?: number;
  localFiles?: boolean;
}) {
  if (images.length === 1) {
    const only = images[0];
    return only === undefined ? null : <MarkdownImage image={only} theme={theme} maxHeight={maxHeight} localFiles={localFiles} />;
  }
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {images.map((image, index) => (
        <View key={`${index}:${image.src}`} style={{ flexGrow: 1, flexBasis: tileMin, minWidth: 0 }}>
          <MarkdownImage image={image} theme={theme} maxHeight={Math.round(maxHeight * 0.66)} localFiles={localFiles} />
        </View>
      ))}
    </View>
  );
}
