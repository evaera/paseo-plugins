/**
 * The user's notes on a card's task, under the card in its view. They are
 * `tasks/<task id>/user-notes.md` in the home, which Mission Control reads
 * before it acts on the task and never writes (charter §2), so anything the
 * user wants it to keep in mind about one task goes here.
 *
 * Saved as the user types, a moment after they stop, and once more when the
 * view closes; the line under the box says where that stands. A worker with no
 * task has nowhere for notes to live, and says so.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";

import { readTaskNotes, writeTaskNotes, type FleetCard } from "../shared/fleet";
import { errorText } from "./format";
import { FONT_SIZE, lineHeightFor } from "./type-scale";

const SAVE_DELAY_MS = 800;

type SaveState = "idle" | "saving" | "saved" | { error: string };

export function TaskNotes({ card, theme }: { card: FleetCard; theme: PluginTheme }) {
  const taskId = card.taskId;
  const styles = useMemo(() => {
    const { colors } = theme;
    return {
      frame: { gap: 6 },
      head: { flexDirection: "row" as const, alignItems: "baseline" as const, gap: 8 },
      label: { color: colors.foregroundMuted, fontSize: FONT_SIZE.micro, fontWeight: "600" as const, letterSpacing: 0.6 },
      status: { flex: 1, textAlign: "right" as const, color: colors.foregroundMuted, fontSize: FONT_SIZE.caption },
      input: {
        minHeight: 140,
        color: colors.foreground,
        fontSize: FONT_SIZE.body,
        lineHeight: lineHeightFor(FONT_SIZE.body),
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        backgroundColor: colors.surface0,
        textAlignVertical: "top" as const,
      },
      none: { color: colors.foregroundMuted, fontSize: FONT_SIZE.small },
    };
  }, [theme]);

  return (
    <View style={styles.frame}>
      <View style={styles.head}>
        <Text style={styles.label}>NOTES</Text>
      </View>
      {taskId === null ? (
        <Text style={styles.none}>This worker has no task on the backlog, so there is nowhere to keep notes for it.</Text>
      ) : (
        <NotesEditor key={taskId} taskId={taskId} theme={theme} styles={styles} />
      )}
    </View>
  );
}

function NotesEditor({
  taskId,
  theme,
  styles,
}: {
  taskId: string;
  theme: PluginTheme;
  styles: { input: object; status: object };
}) {
  const read = useRpc(readTaskNotes);
  const write = useRpc(writeTaskNotes);
  const queryClient = useQueryClient();
  const queryKey = ["mission-control", "notes", taskId];
  const loaded = useQuery({ queryKey, queryFn: () => read({ taskId }) });
  /** What the user has typed; null until they type, so the loaded notes show until then. */
  const [typed, setTyped] = useState<string | null>(null);
  const [state, setState] = useState<SaveState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The text waiting to be saved, so leaving the view saves it. */
  const unsaved = useRef<string | null>(null);

  function save(text: string): void {
    unsaved.current = null;
    setState("saving");
    write({ taskId, text })
      .then(() => setState("saved"))
      .catch((caught: unknown) => setState({ error: errorText(caught) }));
  }

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (unsaved.current !== null) void write({ taskId, text: unsaved.current }).catch(() => {});
    },
    [taskId, write],
  );

  function change(text: string): void {
    setTyped(text);
    // So the view opened again shows what was typed, even before the save lands.
    queryClient.setQueryData(queryKey, { text });
    unsaved.current = text;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => save(text), SAVE_DELAY_MS);
  }

  const value = typed ?? loaded.data?.text.replace(/\n$/, "") ?? "";
  const status =
    loaded.isPending && typed === null
      ? "Loading…"
      : loaded.isError && typed === null
        ? errorText(loaded.error)
        : state === "saving"
          ? "Saving…"
          : state === "saved"
            ? "Saved"
            : typeof state === "object"
              ? `Not saved: ${state.error}`
              : "";
  return (
    <>
      <TextInput
        value={value}
        onChangeText={change}
        // Not before the notes have loaded: typing over a read that failed would save over them.
        editable={loaded.isSuccess || typed !== null}
        placeholder="Jot something down here…"
        placeholderTextColor={theme.colors.foregroundMuted}
        accessibilityLabel="Notes on this task"
        multiline
        style={styles.input}
      />
      {status === "" ? null : (
        <Text style={styles.status} numberOfLines={2}>
          {status}
        </Text>
      )}
    </>
  );
}
