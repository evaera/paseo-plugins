/**
 * Mission Control's context, and the two things to do about it: compact it,
 * or restart Mission Control from scratch. The ring sits in the composer's
 * toolbar, as Paseo's does; pressing it opens a small menu above it with the
 * numbers and both actions, so the toolbar keeps to the everyday ones. Before
 * the first turn there are no numbers to draw, and a "more" icon stands in.
 *
 * Restart asks first, in a host `Modal`: it ends the conversation. The records
 * carry over, the old conversation stays readable in Paseo, and the crewmates
 * keep running — but Paseo tells only the agent that started a crewmate when
 * it finishes, so the new Mission Control checks on those on its wake.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { compactCoordinator, restartCoordinator } from "../shared/fleet";
import { ProgressRing } from "./context-meter";
import { contextPercent, contextTone, formatTokenCount } from "./format";
import { IconButton, errorText } from "./ui";
import { FONT_SIZE, lineHeightFor } from "./type-scale";

export function CoordinatorControls({
  theme,
  compact,
  usedTokens,
  maxTokens,
  running,
  onChanged,
}: {
  theme: PluginTheme;
  compact: boolean;
  usedTokens: number | null | undefined;
  maxTokens: number | null | undefined;
  /** A turn is in flight: neither a compact nor a restart may cut into it, and the daemon refuses both. */
  running: boolean;
  /** Called once the change is made, so the board picks up the new state at once. */
  onChanged: () => void;
}) {
  const compactNow = useRpc(compactCoordinator);
  const restartNow = useRpc(restartCoordinator);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [open, setOpen] = useState(false);
  const percent = contextPercent(usedTokens, maxTokens);
  const tone = contextTone(theme, percent ?? 0);

  const styles = useMemo(
    () => ({
      group: { alignItems: "center" as const, justifyContent: "center" as const },
      trigger: { width: 28, height: 28, alignItems: "center" as const, justifyContent: "center" as const, borderRadius: 6 },
      menu: {
        position: "absolute" as const,
        bottom: 34,
        right: 0,
        zIndex: 30,
        width: 230,
        gap: 8,
        padding: 10,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
      },
      menuTitle: { color: theme.colors.foreground, fontSize: FONT_SIZE.small, fontWeight: "600" as const },
      menuShare: { color: tone, fontSize: FONT_SIZE.small },
      menuDetail: { color: theme.colors.foregroundMuted, fontSize: FONT_SIZE.caption },
      menuActions: { flexDirection: "row" as const, gap: 6, marginTop: 2 },
      text: { color: theme.colors.foreground, fontSize: FONT_SIZE.content, lineHeight: lineHeightFor(FONT_SIZE.content) },
      muted: { color: theme.colors.foregroundMuted, fontSize: FONT_SIZE.body, lineHeight: lineHeightFor(FONT_SIZE.body) },
      actions: { flexDirection: "row" as const, gap: 8, justifyContent: "flex-end" as const },
    }),
    [theme, tone],
  );
  const known = percent !== null && typeof usedTokens === "number" && typeof maxTokens === "number";
  const rounded = percent === null ? 0 : Math.round(percent);
  const tokens = known ? `${formatTokenCount(usedTokens)} / ${formatTokenCount(maxTokens)} tokens` : null;

  function run(action: () => Promise<unknown>, success: string): void {
    setBusy(true);
    action()
      .then(() => {
        toast.show(success, { variant: "success" });
        onChanged();
      })
      .catch((caught: unknown) => toast.error(errorText(caught)))
      .finally(() => setBusy(false));
  }

  return (
    <View style={styles.group}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={known ? `Context window ${rounded}% used, ${tokens}. Compact or restart` : "Compact or restart"}
        accessibilityState={{ expanded: open }}
        style={styles.trigger}
        onPress={() => setOpen(!open)}
      >
        {known ? (
          <ProgressRing percent={percent} color={tone} track={theme.colors.border} />
        ) : (
          <Icon name="Ellipsis" size={16} color={theme.colors.foregroundMuted} />
        )}
      </Pressable>
      {open ? (
        <View style={styles.menu}>
          <Text style={styles.menuTitle}>Context window</Text>
          {known ? (
            <>
              <Text style={styles.menuShare}>{rounded}% used</Text>
              <Text style={styles.menuDetail}>{tokens}</Text>
            </>
          ) : (
            <Text style={styles.menuDetail}>Not measured until the first reply.</Text>
          )}
          <View style={styles.menuActions}>
            <IconButton
              icon="Shrink"
              label="Compact"
              showLabel
              theme={theme}
              disabled={busy || running}
              onPress={() => {
                setOpen(false);
                run(() => compactNow({}), "Mission Control is compacting its context.");
              }}
            />
            <IconButton
              icon="RotateCcw"
              label="Restart"
              showLabel
              theme={theme}
              disabled={busy || running}
              onPress={() => {
                setOpen(false);
                setConfirming(true);
              }}
            />
          </View>
        </View>
      ) : null}
      <Modal title="Restart Mission Control?" open={confirming} onOpenChange={setConfirming}>
        <Modal.Content>
          <Text style={styles.text}>
            A new Mission Control starts from scratch, with the same model and settings. This conversation ends; it stays
            readable in Paseo's history.
          </Text>
          <Text style={styles.muted}>
            Its records carry over — your standing orders, the projects, the backlog — and it picks up from them.
            Workers already running keep running; the new Mission Control checks on them regularly, since Paseo only tells
            the agent that started a worker when it finishes.
          </Text>
          <View style={styles.actions}>
            <IconButton icon="X" label="Cancel" showLabel theme={theme} onPress={() => setConfirming(false)} />
            <IconButton
              icon="RotateCcw"
              label="Restart"
              showLabel
              tone="danger"
              theme={theme}
              disabled={busy || running}
              onPress={() => {
                setConfirming(false);
                run(() => restartNow({}), "Mission Control is starting afresh.");
              }}
            />
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}
