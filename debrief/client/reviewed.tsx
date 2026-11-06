/**
 * The "Reviewed" pieces, as GitHub's and Crit's "Viewed": the checkbox on a
 * file's section header, the mark in the file list, the progress ring in the
 * panel header, and the question asked before marking a file that still has
 * open comments. The state itself is the daemon's (`server/reviewed.ts`).
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";

import type { DiffFile, ReviewState } from "../shared/review";
import { Button } from "./ui";

/** Reviewed files over all of them; a changed file counts as not reviewed. */
export function reviewProgress(files: readonly Pick<DiffFile, "reviewState">[]): { done: number; total: number } {
  return { done: files.filter((file) => file.reviewState === "reviewed").length, total: files.length };
}

/** The checkbox and its word, for a section header. */
export function ReviewedToggle({
  state,
  path,
  theme,
  onPress,
}: {
  state: ReviewState | null;
  path: string;
  theme: PluginTheme;
  onPress: () => void;
}) {
  const colors = theme.colors;
  const checked = state === "reviewed";
  const color = checked ? colors.statusSuccess : state === "changed" ? colors.statusWarning : colors.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={checked ? `Approved ${path}; press to unmark` : `Approve ${path}`}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingLeft: 6,
        paddingRight: 9,
        paddingVertical: 3,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: state === "changed" ? colors.statusWarning : colors.border,
        backgroundColor: pressed ? colors.surface2 : colors.surface1,
      })}
    >
      {/* GitHub's "Viewed": an outlined box that fills with a check. */}
      <View
        style={{
          width: 14,
          height: 14,
          borderRadius: 3,
          borderWidth: 1,
          borderColor: checked ? colors.accent : color,
          backgroundColor: checked ? colors.accent : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {checked ? <Icon name="Check" size={11} color={colors.accentForeground} /> : null}
      </View>
      <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "500" }}>{checked ? "Approved" : "Approve"}</Text>
    </Pressable>
  );
}

/** The file list's mark: a check for reviewed, a yellow dot for changed since. */
export function ReviewedMark({ state, theme }: { state: ReviewState | null | undefined; theme: PluginTheme }) {
  if (state === "reviewed") {
    return (
      <View accessible accessibilityLabel="Approved">
        <Icon name="Check" size={13} color={theme.colors.statusSuccess} />
      </View>
    );
  }
  if (state === "changed") {
    return (
      <View
        accessible
        accessibilityLabel="Changed since approved"
        style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: theme.colors.statusWarning, marginHorizontal: 3 }}
      />
    );
  }
  return null;
}

/**
 * A ring that fills clockwise from twelve o'clock, without SVG: each half of
 * the ring is a clipped box holding a half-disc that rotates into view, and a
 * disc of the background colour on top hollows the middle out.
 */
export function ProgressRing({
  done,
  total,
  theme,
  size = 16,
  stroke = 3,
}: {
  done: number;
  total: number;
  theme: PluginTheme;
  size?: number;
  stroke?: number;
}) {
  const colors = theme.colors;
  const fraction = total <= 0 ? 0 : Math.min(1, Math.max(0, done / total));
  const degrees = fraction * 360;
  const half = size / 2;
  const fill = fraction >= 1 ? colors.statusSuccess : colors.accent;
  const styles = useMemo(
    () => ({
      ring: { width: size, height: size, borderRadius: half, overflow: "hidden" as const, backgroundColor: colors.border },
      clipRight: { position: "absolute" as const, left: half, top: 0, width: half, height: size, overflow: "hidden" as const },
      clipLeft: { position: "absolute" as const, left: 0, top: 0, width: half, height: size, overflow: "hidden" as const },
      frame: { position: "absolute" as const, top: 0, width: size, height: size },
      leftDisc: {
        position: "absolute" as const,
        left: 0,
        top: 0,
        width: half,
        height: size,
        borderTopLeftRadius: half,
        borderBottomLeftRadius: half,
      },
      rightDisc: {
        position: "absolute" as const,
        left: half,
        top: 0,
        width: half,
        height: size,
        borderTopRightRadius: half,
        borderBottomRightRadius: half,
      },
      hole: {
        position: "absolute" as const,
        left: stroke,
        top: stroke,
        width: size - stroke * 2,
        height: size - stroke * 2,
        borderRadius: (size - stroke * 2) / 2,
        backgroundColor: colors.surface1,
      },
    }),
    [colors, size, half, stroke],
  );
  // The right half: a left half-disc turned clockwise by up to 180 degrees sweeps into it.
  const rightTurn = Math.min(degrees, 180);
  // The left half: a right half-disc turned by what is past 180 sweeps into it.
  const leftTurn = Math.max(0, degrees - 180);
  return (
    <View style={styles.ring}>
      {degrees > 0 ? (
        <View style={styles.clipRight}>
          <View style={[styles.frame, { left: -half, transform: [{ rotate: `${rightTurn}deg` }] }]}>
            <View style={[styles.leftDisc, { backgroundColor: fill }]} />
          </View>
        </View>
      ) : null}
      {leftTurn > 0 ? (
        <View style={styles.clipLeft}>
          <View style={[styles.frame, { left: 0, transform: [{ rotate: `${leftTurn}deg` }] }]}>
            <View style={[styles.rightDisc, { backgroundColor: fill }]} />
          </View>
        </View>
      ) : null}
      <View style={styles.hole} />
    </View>
  );
}

/** The ring and "N/M", for the panel header. */
export function ReviewProgress({ done, total, theme }: { done: number; total: number; theme: PluginTheme }) {
  const label = `${done} of ${total} file${total === 1 ? "" : "s"} approved`;
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: total, now: done }}
      // react-native-web passes `title` through as the tooltip; native ignores it.
      {...({ title: label } as object)}
      style={{ flexDirection: "row", alignItems: "center", gap: 5 }}
    >
      <ProgressRing done={done} total={total} theme={theme} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}>{`${done}/${total}`}</Text>
    </View>
  );
}

/** Asked before marking a file reviewed while it still has open comments. */
export function ReviewedPrompt({
  path,
  open,
  theme,
  onResolve,
  onKeep,
  onCancel,
}: {
  /** Null closes it. */
  path: string | null;
  open: number;
  theme: PluginTheme;
  onResolve: () => void;
  onKeep: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      title="Approve this file?"
      open={path !== null}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <Modal.Content>
        <Text style={{ color: theme.colors.foreground }}>
          {`This file has ${open} open comment${open === 1 ? "" : "s"}. Resolve ${open === 1 ? "it" : "them"} and approve the file?`}
        </Text>
        {path !== null ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 4 }}>{path}</Text> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
          <Button label="Resolve and approve" tone="accent" theme={theme} onPress={onResolve} />
          <Button label="Approve, keep open" theme={theme} onPress={onKeep} />
          <Button label="Cancel" tone="quiet" theme={theme} onPress={onCancel} />
        </View>
      </Modal.Content>
    </Modal>
  );
}
