import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useState } from "react";
import { AccessibilityInfo, Text, View } from "react-native";

import { FONT_SIZE } from "./type-scale";

const DOT_PATH = [0, 1, 3, 5, 4, 2];
const DOT_OPACITY = [1, 0.78, 0.56, 0.34, 0, 0];
const STEP_MS = 160;

export function TurnWorking({ startedAt, theme }: { startedAt: string | null; theme: PluginTheme }) {
  const [now, setNow] = useState(Date.now);
  const [reduceMotion, setReduceMotion] = useState(true);
  const start = startedAt === null ? NaN : Date.parse(startedAt);
  const elapsed = Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1000)) : null;

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled?.()
      .then((enabled) => { if (mounted) setReduceMotion(enabled); })
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener?.("reduceMotionChanged", setReduceMotion);
    return () => {
      mounted = false;
      subscription?.remove();
    };
  }, []);

  useEffect(() => {
    if (reduceMotion && !Number.isFinite(start)) return undefined;
    const interval = setInterval(() => setNow(Date.now()), reduceMotion ? 1000 : STEP_MS);
    return () => clearInterval(interval);
  }, [reduceMotion, start]);

  const phase = reduceMotion ? 0 : Math.floor(now / STEP_MS) % DOT_PATH.length;
  const minutes = elapsed === null ? 0 : Math.floor(elapsed / 60);
  const seconds = elapsed === null ? 0 : elapsed % 60;
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Mission Control is working"
      style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 18 }}
    >
      <View style={{ width: 14, height: 14, alignItems: "center" }}>
        <View style={{ width: 9, height: 14 }}>
          {DOT_PATH.map((position, index) => (
            <View
              key={position}
              style={{
                position: "absolute",
                left: (position % 2) * 5,
                top: Math.floor(position / 2) * 5,
                width: 4,
                height: 4,
                borderRadius: 2,
                backgroundColor: theme.colors.foreground,
                opacity: DOT_OPACITY[(phase - index + DOT_PATH.length) % DOT_PATH.length],
              }}
            />
          ))}
        </View>
      </View>
      {elapsed === null ? null : (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT_SIZE.caption, fontVariant: ["tabular-nums"] }}>
          {minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`}
        </Text>
      )}
    </View>
  );
}
