/**
 * An image opened from the chat: only the image, over a curtain that dims the whole app, as Paseo's
 * own attachment viewer and Discord's do it. React Native's `Modal`, transparent, is what reaches
 * past the plugin's surface: the web renderer portals it to the document's body with a focus trap,
 * and native presents it over the window. The host's `Modal` is a boxed dialog and cannot.
 *
 * The wheel and a trackpad pinch zoom toward the pointer, a drag pans, two fingers pinch, a double
 * click or tap goes between fit and real size, and a press on the curtain, Escape or the button
 * closes. The rules are `./lightbox-zoom`'s; this file feeds them and draws the result.
 *
 * **Its colours are fixed, not theme tokens, on purpose.** The curtain is dark in a light theme too,
 * as a photo viewer's is, and no token says "dark whatever the theme", so the marks drawn on it are
 * fixed light ones.
 */
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Image,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  SafeAreaView,
  Text,
  View,
  useWindowDimensions,
  type GestureResponderEvent,
  type ViewStyle,
} from "react-native";

import { TOUCH_TARGET } from "./layout-tier";
import {
  KEY_ZOOM_STEP,
  TouchGesture,
  clampTransform,
  fitMargin,
  fitTransform,
  imageFrame,
  isAtFit,
  keyAction,
  tapAction,
  toggleZoom,
  wheelScale,
  zoomAt,
  type Geometry,
  type Size,
  type Tap,
  type Touch,
  type Transform,
} from "./lightbox-zoom";
import { FONT_SIZE, lineHeightFor } from "./type-scale";
import { Spinner } from "./ui";
import { primaryPointerCoarse, rememberFocus, takeKeys, takeWheel } from "./web";

const CURTAIN = "rgba(0, 0, 0, 0.86)";
const INK = "#ffffff";
const INK_MUTED = "rgba(255, 255, 255, 0.74)";
const BUTTON = "rgba(255, 255, 255, 0.14)";
const BUTTON_HOVER = "rgba(255, 255, 255, 0.26)";
const CAPTION_GROUND = "rgba(0, 0, 0, 0.55)";

const FILL = { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 } as const;
/** Stands in until the image's size is known, so a gesture that started early is still tracked to its end. */
const NO_GEOMETRY: Geometry = { image: { width: 0, height: 0 }, viewport: { width: 0, height: 0 }, margin: 0 };

/**
 * The web renderer synthesises a click after a touch ends, and the tap that closed the lightbox ends
 * over whatever was under it, often the very image that opened it. An opener asks this before opening.
 */
let closedAt = 0;
export function lightboxJustClosed(): boolean {
  return Date.now() - closedAt < 400;
}

export interface LightboxImage {
  /** Null while the image is on its way, or when `problem` says why there is none. */
  uri: string | null;
  /** The image's real size in pixels; null has the lightbox ask the app's loader. */
  size: Size | null;
  /** Read out for the image. */
  label: string;
  /** Drawn small at the foot. */
  caption: string | null;
  problem: string | null;
}

function touchesOf(event: GestureResponderEvent, origin: { x: number; y: number }): Touch[] {
  return event.nativeEvent.touches.map((touch) => ({
    id: Number(touch.identifier),
    x: touch.pageX - origin.x,
    y: touch.pageY - origin.y,
  }));
}

function RoundButton({ icon, label, size, onPress, focusOnMount = false }: { icon: string; label: string; size: number; onPress: () => void; focusOnMount?: boolean }) {
  const [hovered, setHovered] = useState(false);
  const button = useRef<View>(null);
  useEffect(() => {
    // The web's focus trap would pick the first focusable itself; naming it keeps that the way out.
    if (focusOnMount && Platform.OS === "web") button.current?.focus();
  }, [focusOnMount]);
  return (
    <Pressable
      ref={button}
      accessibilityRole="button"
      accessibilityLabel={label}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: hovered || pressed ? BUTTON_HOVER : BUTTON,
      })}
    >
      <Icon name={icon} size={Math.round(size * 0.5)} color={INK} />
    </Pressable>
  );
}

/**
 * The lightbox for one image. Key it by the image so stepping to a neighbour starts at fit.
 * `onPrevious` and `onNext` are given only where the group has a neighbour that way.
 */
export function Lightbox({
  image,
  onClose,
  onPrevious,
  onNext,
}: {
  image: LightboxImage;
  onClose: () => void;
  onPrevious?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
}) {
  const window = useWindowDimensions();
  const root = useRef<View>(null);
  /** The viewport's corner in the window, which touch points are reported against. */
  const origin = useRef({ x: 0, y: 0 });
  const [viewport, setViewport] = useState<Size>({ width: window.width, height: window.height });
  const [asked, setAsked] = useState<Size | null>(null);
  const [failed, setFailed] = useState(false);
  /** Null is "at fit", whatever fit comes to: a resized window refits an image nobody zoomed. */
  const [zoom, setZoom] = useState<Transform | null>(null);
  const [touch] = useState(primaryPointerCoarse);

  const { uri } = image;
  const size = image.size ?? asked;
  useEffect(() => {
    if (uri === null || image.size !== null) return;
    let live = true;
    Image.getSize(
      uri,
      (width, height) => {
        if (live && width > 0 && height > 0) setAsked({ width, height });
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [uri, image.size]);

  const geometry = useMemo<Geometry | null>(
    () => (size === null || viewport.width <= 0 || viewport.height <= 0 ? null : { image: size, viewport, margin: fitMargin(viewport) }),
    [size, viewport],
  );
  const transform = geometry === null ? null : zoom === null ? fitTransform(geometry) : clampTransform(zoom, geometry);

  const close = () => {
    closedAt = Date.now();
    onClose();
  };
  /** What the gesture, wheel and key handlers read: they are bound once and outlive any one render. */
  const live = useRef({ geometry, transform, close, onPrevious, onNext });
  live.current = { geometry, transform, close, onPrevious, onNext };
  /**
   * Moves the image. The handlers' copy is set at once, not at the next render: a wheel or a
   * trackpad sends several events between two renders, and each has to start from the last.
   */
  const apply = useRef((next: Transform, at: Geometry) => {
    live.current.transform = next;
    setZoom(isAtFit(next, at) ? null : next);
  }).current;

  // The web renderer's own modal notes the focused element only after it has moved the focus inside.
  const [restoreFocus] = useState(rememberFocus);
  useEffect(() => restoreFocus, [restoreFocus]);

  const responder = useMemo(() => {
    const gesture = new TouchGesture();
    let lastTap: Tap | null = null;
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event) => gesture.begin(touchesOf(event, origin.current)),
      // A second finger landing is a start, not a move, and has to join the gesture's frame.
      onPanResponderStart: (event) => gesture.move(touchesOf(event, origin.current), live.current.transform ?? fitTransform(NO_GEOMETRY), NO_GEOMETRY),
      onPanResponderMove: (event) => {
        const { geometry: at, transform: from } = live.current;
        const touches = touchesOf(event, origin.current);
        if (at === null || from === null) {
          gesture.move(touches, fitTransform(NO_GEOMETRY), NO_GEOMETRY);
          return;
        }
        const next = gesture.move(touches, from, at);
        if (next.scale !== from.scale || next.x !== from.x || next.y !== from.y) apply(next, at);
      },
      onPanResponderRelease: (event) => {
        const point = gesture.end();
        if (point === null) return;
        const { geometry: at, transform: from } = live.current;
        const tap = { ...point, at: Date.now() };
        const action = tapAction(tap, lastTap, from ?? fitTransform(NO_GEOMETRY), at);
        lastTap = action === "none" ? tap : null;
        if (action === "close") {
          // Keeps the browser from following a touch with a click on what the curtain covered.
          event.preventDefault();
          live.current.close();
        } else if (action === "toggle" && at !== null && from !== null) {
          apply(toggleZoom(from, tap, at), at);
        }
      },
      onPanResponderTerminate: () => {
        gesture.end();
      },
    });
  }, []);

  useEffect(
    () =>
      takeWheel(root.current, (wheel) => {
        const { geometry: at, transform: from } = live.current;
        if (at === null || from === null) return;
        const focal = { x: wheel.x - origin.current.x, y: wheel.y - origin.current.y };
        apply(zoomAt(from, wheelScale(from.scale, wheel.deltaY, wheel.pinch, wheel.deltaMode), focal, at), at);
      }),
    [],
  );

  useEffect(
    () =>
      takeKeys((key) => {
        const now = live.current;
        const action = keyAction(key, { hasPrevious: now.onPrevious !== undefined, hasNext: now.onNext !== undefined });
        if (action === null) return false;
        if (action === "close") now.close();
        else if (action === "previous") now.onPrevious?.();
        else if (action === "next") now.onNext?.();
        else if (now.geometry === null || now.transform === null) return true;
        else if (action === "fit") apply(fitTransform(now.geometry), now.geometry);
        else {
          const centre = { x: now.geometry.viewport.width / 2, y: now.geometry.viewport.height / 2 };
          const scale = now.transform.scale * (action === "zoom-in" ? KEY_ZOOM_STEP : 1 / KEY_ZOOM_STEP);
          apply(zoomAt(now.transform, scale, centre, now.geometry), now.geometry);
        }
        return true;
      }),
    [],
  );

  const problem = image.problem ?? (failed ? `Couldn't load ${image.label}` : null);
  const buttonSize = touch ? TOUCH_TARGET : 36;
  const margin = fitMargin(viewport);
  // `touchAction` and `userSelect` are the web's: without them the browser scrolls, zooms the page or
  // selects text under a drag. React Native's style types do not carry `touchAction`.
  const webOnly = (Platform.OS === "web" ? { touchAction: "none", userSelect: "none" } : {}) as ViewStyle;

  let body = null;
  if (problem !== null) {
    body = (
      <View pointerEvents="none" style={[FILL, { alignItems: "center", justifyContent: "center", padding: 24 }]}>
        <Text style={{ color: INK_MUTED, fontSize: FONT_SIZE.body, lineHeight: lineHeightFor(FONT_SIZE.body), textAlign: "center" }}>{problem}</Text>
      </View>
    );
  } else if (uri === null) {
    body = (
      <View pointerEvents="none" style={[FILL, { alignItems: "center", justifyContent: "center" }]}>
        <Spinner size={22} color={INK_MUTED} />
      </View>
    );
  } else {
    // Until its size is known the image is drawn contained, at fit, and nothing zooms.
    const frame = geometry !== null && transform !== null ? imageFrame(transform, geometry) : { left: margin, top: margin, right: margin, bottom: margin };
    body = (
      // The gestures are the viewport's: an image that took a press would also start a drag of its own on the web.
      <View pointerEvents="none" style={[{ position: "absolute" }, frame]}>
        <Image
          source={{ uri }}
          accessibilityLabel={image.label}
          resizeMode="contain"
          onError={() => setFailed(true)}
          style={{ width: "100%", height: "100%" }}
        />
      </View>
    );
  }

  return (
    <Modal transparent visible animationType="fade" statusBarTranslucent navigationBarTranslucent supportedOrientations={["portrait", "landscape"]} onRequestClose={close}>
      <View
        ref={root}
        role="dialog"
        aria-modal
        accessibilityViewIsModal
        accessibilityLabel={`Image viewer: ${image.label}`}
        style={[{ flex: 1, backgroundColor: CURTAIN, overflow: "hidden" }, webOnly]}
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setViewport((before) => (before.width === width && before.height === height ? before : { width, height }));
          root.current?.measureInWindow((x, y) => {
            origin.current = { x, y };
          });
        }}
        {...responder.panHandlers}
      >
        {body}
        <SafeAreaView pointerEvents="box-none" style={FILL}>
          <View pointerEvents="box-none" style={{ flex: 1 }}>
            <View style={{ position: "absolute", top: 12, right: 12 }}>
              <RoundButton icon="X" label="Close the image" size={buttonSize} onPress={close} focusOnMount />
            </View>
            {onPrevious === undefined ? null : (
              <View pointerEvents="box-none" style={{ position: "absolute", left: 12, top: 0, bottom: 0, justifyContent: "center" }}>
                <RoundButton icon="ChevronLeft" label="Previous image" size={buttonSize} onPress={onPrevious} />
              </View>
            )}
            {onNext === undefined ? null : (
              <View pointerEvents="box-none" style={{ position: "absolute", right: 12, top: 0, bottom: 0, justifyContent: "center" }}>
                <RoundButton icon="ChevronRight" label="Next image" size={buttonSize} onPress={onNext} />
              </View>
            )}
            {image.caption === null ? null : (
              <View pointerEvents="none" style={{ position: "absolute", left: 12, right: 12, bottom: 12, alignItems: "center" }}>
                <Text
                  numberOfLines={2}
                  style={{
                    maxWidth: 640,
                    paddingHorizontal: 10,
                    paddingVertical: 4,
                    borderRadius: 8,
                    overflow: "hidden",
                    backgroundColor: CAPTION_GROUND,
                    color: INK_MUTED,
                    fontSize: FONT_SIZE.small,
                    lineHeight: lineHeightFor(FONT_SIZE.small),
                    textAlign: "center",
                  }}
                >
                  {image.caption}
                </Text>
              </View>
            )}
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}
