/**
 * A Markdown image, drawn: an `https://` or `data:` image loaded by the app, or a file on the
 * daemon's machine sent base64 by `mission-control.files.image`, which decides what may be read
 * (the home and registered project roots only, `server/local-files.ts`).
 *
 * A local image is fetched only once it scrolls near the view (`whenNearView`), two at a time
 * across the plugin, and kept in the query cache for five minutes, so a chat of screenshots neither
 * fetches every one on mount nor fetches one again on every remount. Pressing an image opens it
 * in the lightbox (`./lightbox`), where a gallery's arrows step through its images.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Image, Pressable, Text, View } from "react-native";

import { readImage } from "../shared/files";
import { errorText } from "./format";
import { classifyImage, fitImage, imageName, refusalText } from "./image-source";
import { Lightbox, lightboxJustClosed } from "./lightbox";
import { stepIndex } from "./lightbox-zoom";
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

/** The image the lightbox is on, resolved the way the chat drew it: a local one comes out of the query cache. */
function OpenedImage({
  image,
  localFiles,
  onClose,
  onPrevious,
  onNext,
}: {
  image: ImageRef;
  localFiles: boolean;
  onClose: () => void;
  onPrevious: (() => void) | undefined;
  onNext: (() => void) | undefined;
}) {
  const source = useMemo(() => classifyImage(image.src), [image.src]);
  const local = source.kind === "local" && localFiles;
  const loaded = useLocalImage(image.src, local);
  const remote = useRemoteSize(source.kind === "remote" ? source.uri : null);

  let uri: string | null = null;
  let problem: string | null = null;
  let natural: { width: number | null; height: number | null } = { width: null, height: null };
  if (source.kind === "invalid") problem = refusalText("invalid", image.src, null);
  else if (source.kind === "local" && !localFiles) problem = refusalText("other-host", image.src, null);
  else if (source.kind === "remote") {
    if (remote.failed) problem = refusalText("failed", image.src, null);
    else {
      uri = source.uri;
      natural = remote;
    }
  } else if (loaded.state === "refused") problem = loaded.text;
  else if (loaded.state === "ok") {
    uri = loaded.uri;
    natural = loaded;
  }
  const size = natural.width !== null && natural.height !== null && natural.width > 0 && natural.height > 0 ? { width: natural.width, height: natural.height } : null;
  return (
    <Lightbox
      image={{ uri, size, label: image.alt.trim() === "" ? imageName(image.src) : image.alt, caption: caption(image.alt), problem }}
      onClose={onClose}
      onPrevious={onPrevious}
      onNext={onNext}
    />
  );
}

/** The lightbox over a group of images, on the one at `index`; the arrows step through the group. */
function GroupLightbox({
  images,
  index,
  localFiles,
  onIndex,
  onClose,
}: {
  images: readonly ImageRef[];
  index: number;
  localFiles: boolean;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const image = images[index];
  if (image === undefined) return null;
  const previous = stepIndex(index, -1, images.length);
  const next = stepIndex(index, 1, images.length);
  return (
    <OpenedImage
      // Keyed by its place, so a neighbour opens at fit rather than at the last one's zoom.
      key={`${index}:${image.src}`}
      image={image}
      localFiles={localFiles}
      onClose={onClose}
      onPrevious={previous === null ? undefined : () => onIndex(previous)}
      onNext={next === null ? undefined : () => onIndex(next)}
    />
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
  const [open, setOpen] = useState(false);
  return (
    <>
      <InlineImage image={image} theme={theme} maxHeight={maxHeight} localFiles={localFiles} onOpen={() => setOpen(true)} />
      {open ? <GroupLightbox images={[image]} index={0} localFiles={localFiles} onIndex={() => {}} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function InlineImage({
  image,
  theme,
  maxHeight,
  localFiles,
  onOpen,
}: {
  image: ImageRef;
  theme: PluginTheme;
  maxHeight: number;
  localFiles: boolean;
  onOpen: () => void;
}) {
  const source = useMemo(() => classifyImage(image.src), [image.src]);
  const frame = useRef<View>(null);
  const [width, setWidth] = useState(0);
  const [near, setNear] = useState(() => seenSources.has(image.src));
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
          accessibilityHint="Opens the image in a viewer"
          onPress={() => {
            if (!lightboxJustClosed()) onOpen();
          }}
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
  const [open, setOpen] = useState<number | null>(null);
  const lightbox =
    open === null ? null : <GroupLightbox images={images} index={open} localFiles={localFiles} onIndex={setOpen} onClose={() => setOpen(null)} />;
  if (images.length === 1) {
    const only = images[0];
    return only === undefined ? null : (
      <>
        <InlineImage image={only} theme={theme} maxHeight={maxHeight} localFiles={localFiles} onOpen={() => setOpen(0)} />
        {lightbox}
      </>
    );
  }
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {images.map((image, index) => (
        <View key={`${index}:${image.src}`} style={{ flexGrow: 1, flexBasis: tileMin, minWidth: 0 }}>
          <InlineImage image={image} theme={theme} maxHeight={Math.round(maxHeight * 0.66)} localFiles={localFiles} onOpen={() => setOpen(index)} />
        </View>
      ))}
      {lightbox}
    </View>
  );
}
