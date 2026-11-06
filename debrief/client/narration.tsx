/**
 * A story annotation drawn with React Native: in the native diff, and above
 * the web editor for the old side in unified mode, where the editor has no
 * old lines to hang it on. The web editor draws its own (`editor/narration.ts`).
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Markdown } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Text, View } from "react-native";

import type { Annotation } from "../shared/story";
import { rangeLabel } from "./format";

export function NarrationBlock({
  annotation,
  theme,
  showLine = false,
}: {
  annotation: Annotation;
  theme: PluginTheme;
  showLine?: boolean;
}) {
  const colors = theme.colors;
  const styles = useMemo(
    () => ({
      // Interlinear, as in the web editor: prose between the lines, not a card.
      block: {
        borderLeftWidth: 2,
        borderLeftColor: colors.accent,
        paddingLeft: 10,
        paddingVertical: 4,
        marginVertical: 2,
        gap: 2,
        opacity: 0.92,
      },
      meta: { color: colors.foregroundMuted, fontSize: 11 },
      drifted: { color: colors.statusWarning, fontSize: 11 },
    }),
    [colors],
  );
  return (
    <View style={styles.block}>
      {showLine ? <Text style={styles.meta}>{rangeLabel({ startLine: annotation.line, side: annotation.side })}</Text> : null}
      <Markdown>{annotation.body}</Markdown>
      {annotation.drifted ? <Text style={styles.drifted}>The code here moved since this was written.</Text> : null}
    </View>
  );
}
