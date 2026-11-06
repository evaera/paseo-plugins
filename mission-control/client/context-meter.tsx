/**
 * How full Mission Control's context window is, drawn in the composer's
 * toolbar the way Paseo's composer draws its own: a ring filling clockwise
 * from the top, coloured at the same thresholds. Pressing it opens the menu
 * with the numbers, Compact and Restart (`./coordinator-controls`).
 *
 * Paseo's ring is SVG, and `react-native-svg` is not a module a plugin may
 * import, so this one is built from views. Each half of the circle is a clip
 * holding a ring whose border is coloured on two adjacent sides only — a
 * rounded border splits its sides at the diagonals, so that is exactly half a
 * ring — and rotating it slides the coloured half into view: the right clip
 * fills the first 180°, the left clip the rest.
 */
import { View } from "react-native";

/** The icon size the chat's buttons use, and Paseo's stroke. */
const RING_SIZE = 14;
const RING_STROKE = 2;

/**
 * The uncoloured sides of a half ring. Not a colour of the palette, so not
 * a theme token: it is the absence of one, the same in every theme.
 */
const NONE = "transparent";

export function ProgressRing({
  percent,
  color,
  track,
  size = RING_SIZE,
  stroke = RING_STROKE,
}: {
  percent: number;
  color: string;
  track: string;
  size?: number;
  stroke?: number;
}) {
  const share = Math.min(1, Math.max(0, percent / 100));
  const ring = {
    position: "absolute" as const,
    top: 0,
    width: size,
    height: size,
    borderRadius: size / 2,
    borderWidth: stroke,
  };
  const half = { position: "absolute" as const, top: 0, width: size / 2, height: size, overflow: "hidden" as const };
  return (
    <View style={{ width: size, height: size }}>
      <View style={[ring, { left: 0, borderColor: track }]} />
      {/*
        Bottom and left coloured: 135°–315°, turned by 45° to sit wholly in the hidden left half, then on by
        the share. Not drawn at all for nothing used, where its edge would show as a hairline on the seam.
      */}
      {share === 0 ? null : (
        <View style={[half, { left: size / 2 }]}>
          <View
            style={[
              ring,
              {
                left: -size / 2,
                borderColor: NONE,
                borderBottomColor: color,
                borderLeftColor: color,
                transform: [{ rotate: `${45 + Math.min(share, 0.5) * 360}deg` }],
              },
            ]}
          />
        </View>
      )}
      {share <= 0.5 ? null : (
        // Top and right coloured: -45°–135°, turned by 45° to sit wholly in the hidden right half, then on.
        <View style={[half, { left: 0 }]}>
          <View
            style={[
              ring,
              {
                left: 0,
                borderColor: NONE,
                borderTopColor: color,
                borderRightColor: color,
                transform: [{ rotate: `${45 + (share - 0.5) * 360}deg` }],
              },
            ]}
          />
        </View>
      )}
    </View>
  );
}
