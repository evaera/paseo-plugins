/**
 * A small renderer for the Markdown an agent writes.
 *
 * A client bundle may import only the modules the host provides, so no
 * Markdown library is reachable, and the host has no renderer of its own to
 * lend. This covers what a Mission Control agent's reply actually uses — headings,
 * lists, fenced code, quotes, rules, pipe tables, and bold, code and links
 * inline, with the home's files it names linked (`./file-links`) — and
 * renders anything else as a plain paragraph. It is a trimmed copy of
 * `github-board/client/markdown.tsx`, without the HTML, `<details>` and image
 * handling an issue body needs and an agent's reply does not; there is no
 * workspace root to share one from.
 *
 * Single newlines break lines, so a list the agent wrapped by hand keeps its
 * shape instead of reflowing.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";

import { DebriefEmbed } from "./debrief-embed";
import { inlineTokens, type FileLookup } from "./file-links";
import { parseMarkdown, type Block } from "./markdown-parse";
import { MONOSPACE } from "./ui";
import { FONT_SIZE, lineHeightFor } from "./type-scale";

interface MarkdownStyles {
  paragraph: object;
  heading: object;
  headingLarge: object;
  listRow: object;
  listMarker: object;
  listText: object;
  codeBlock: object;
  codeText: object;
  quote: object;
  rule: object;
  bold: object;
  inlineCode: object;
  link: object;
  table: object;
  tableRow: object;
  tableCell: object;
  tableHeader: object;
}

/** Chat text's line height: looser than the board's, as Paseo's own chat sets it. */
const RELAXED_LINE = 1.6;

function useMarkdownStyles(theme: PluginTheme, fontSize: number, relaxed: boolean): MarkdownStyles {
  const lineHeight = relaxed ? Math.round(fontSize * RELAXED_LINE) : lineHeightFor(fontSize);
  return useMemo(
    () => ({
      paragraph: { color: theme.colors.foreground, fontSize, lineHeight },
      heading: { color: theme.colors.foreground, fontSize: fontSize + 1, fontWeight: "600" as const, marginTop: relaxed ? 8 : 4 },
      headingLarge: { color: theme.colors.foreground, fontSize: fontSize + 3, fontWeight: "700" as const, marginTop: relaxed ? 10 : 6 },
      listRow: { flexDirection: "row" as const, gap: relaxed ? 8 : 6 },
      listMarker: { color: theme.colors.foregroundMuted, fontSize, lineHeight },
      listText: { flex: 1 },
      codeBlock: {
        backgroundColor: theme.colors.surface2,
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 8,
      },
      codeText: { color: theme.colors.foreground, fontFamily: MONOSPACE, fontSize: fontSize - 1 },
      quote: { borderLeftWidth: 3, borderLeftColor: theme.colors.border, paddingLeft: 10, gap: 6 },
      rule: { height: 1, backgroundColor: theme.colors.border, marginVertical: 4 },
      bold: { fontWeight: "700" as const },
      inlineCode: {
        fontFamily: MONOSPACE,
        backgroundColor: theme.colors.surface2,
        color: theme.colors.foreground,
        fontSize: fontSize - 1,
      },
      link: { color: theme.colors.accent, textDecorationLine: "underline" as const },
      table: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6 },
      tableRow: { flexDirection: "row" as const, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
      tableCell: { flex: 1, paddingHorizontal: 8, paddingVertical: 4 },
      tableHeader: { fontWeight: "600" as const },
    }),
    [theme, fontSize, lineHeight, relaxed],
  );
}

const noFiles: FileLookup = () => null;

/** What a press on an inline link does, which paths are files to link, and how a card embed is drawn. */
interface InlineContext {
  lookup: FileLookup;
  onOpenLink: (url: string) => void;
  onOpenFile: ((path: string) => void) | null;
  renderCard: ((ref: string) => ReactNode) | null;
  /** The theme for a Debrief embed's button; null where a button has no board to act on. */
  theme: PluginTheme | null;
}

function renderInline(text: string, styles: MarkdownStyles, context: InlineContext): ReactNode[] {
  // `.map` rather than a loop, because a link's press handler closes over its
  // target and a closure made in a `for…of` body captures the binding's final
  // value under Hermes.
  const { onOpenFile } = context;
  const lookup = onOpenFile === null ? noFiles : context.lookup;
  return inlineTokens(text, lookup).map((token, index) => {
    switch (token.kind) {
      case "text":
        return token.text;
      case "code":
        return (
          <Text key={index} style={styles.inlineCode}>
            {token.text}
          </Text>
        );
      case "bold":
        return (
          <Text key={index} style={styles.bold}>
            {token.text}
          </Text>
        );
      case "file":
        return (
          <Text
            key={index}
            accessibilityRole="link"
            accessibilityHint={`Opens ${token.path} in Files`}
            style={token.code ? [styles.inlineCode, styles.link] : styles.link}
            onPress={() => onOpenFile?.(token.path)}
          >
            {token.text}
          </Text>
        );
      default:
        return (
          <Text key={index} accessibilityRole="link" style={styles.link} onPress={() => context.onOpenLink(token.url)}>
            {token.text}
          </Text>
        );
    }
  });
}

/** A Debrief embed as it was written, near enough: its ref, a view other than the diff, and its path. */
function debriefText(block: Extract<Block, { kind: "debrief" }>): string {
  const parts = [block.ref, block.view === "diff" && block.path === null ? null : block.view, block.path].filter(
    (part): part is string => part !== null,
  );
  return parts.length === 0 ? "[[debrief]]" : `[[debrief: ${parts.join(" ")}]]`;
}

function renderBlocks(blocks: Block[], styles: MarkdownStyles, context: InlineContext): ReactNode[] {
  return blocks.map((block, index) => {
    switch (block.kind) {
      case "heading":
        return (
          <Text key={index} accessibilityRole="header" style={block.level <= 2 ? styles.headingLarge : styles.heading}>
            {renderInline(block.text, styles, context)}
          </Text>
        );
      case "list":
        return (
          <View key={index}>
            {block.items.map((item, itemIndex) => (
              <View key={itemIndex} style={[styles.listRow, { paddingLeft: item.depth * 14 }]}>
                <Text style={styles.listMarker}>{item.marker}</Text>
                <Text style={[styles.paragraph, styles.listText]}>{renderInline(item.text, styles, context)}</Text>
              </View>
            ))}
          </View>
        );
      case "code":
        return (
          <View key={index} style={styles.codeBlock}>
            <Text selectable style={styles.codeText}>
              {block.text}
            </Text>
          </View>
        );
      case "quote":
        return (
          <View key={index} style={styles.quote}>
            {renderBlocks(block.blocks, styles, context)}
          </View>
        );
      case "rule":
        return <View key={index} style={styles.rule} />;
      case "card":
        // Where the reader has no board to draw it from, the embed reads as what it names.
        return context.renderCard === null ? (
          <Text key={index} style={styles.paragraph}>
            {block.ref}
          </Text>
        ) : (
          <View key={index}>{context.renderCard(block.ref)}</View>
        );
      case "debrief":
        // A button only where there is a board to open Debrief from; anywhere else, the embed as written.
        return context.theme === null ? (
          <Text key={index} style={styles.paragraph}>
            {debriefText(block)}
          </Text>
        ) : (
          <DebriefEmbed key={index} refName={block.ref} view={block.view} path={block.path} theme={context.theme} />
        );
      case "table":
        return (
          <View key={index} style={styles.table}>
            {[block.header, ...block.rows].map((cells, rowIndex) => (
              <View key={rowIndex} style={styles.tableRow}>
                {cells.map((cell, cellIndex) => (
                  <View key={cellIndex} style={styles.tableCell}>
                    <Text style={[styles.paragraph, rowIndex === 0 ? styles.tableHeader : null]}>
                      {renderInline(cell, styles, context)}
                    </Text>
                  </View>
                ))}
              </View>
            ))}
          </View>
        );
      default:
        return (
          <Text key={index} selectable style={styles.paragraph}>
            {renderInline(block.text, styles, context)}
          </Text>
        );
    }
  });
}

export function Markdown({
  source,
  theme,
  fontSize = FONT_SIZE.body,
  onOpenLink,
  files = noFiles,
  onOpenFile = null,
  relaxed = false,
  renderCard = null,
  debriefButtons = false,
}: {
  source: string;
  theme: PluginTheme;
  fontSize?: number;
  /** Chat spacing: a looser line height and more room between blocks. */
  relaxed?: boolean;
  onOpenLink: (url: string) => void;
  /** Which paths the text names are files in the home — see `./file-links`; none without `onOpenFile`. */
  files?: FileLookup;
  onOpenFile?: ((path: string) => void) | null;
  /** Draws a `[[card: …]]` embed; without it the embed reads as its id. */
  renderCard?: ((ref: string) => ReactNode) | null;
  /** Draws `[[debrief]]` embeds as buttons; on wherever `renderCard` is given, and in a worker's transcript. */
  debriefButtons?: boolean;
}) {
  const styles = useMarkdownStyles(theme, fontSize, relaxed);
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <View style={{ gap: relaxed ? 12 : 6 }}>
      {renderBlocks(blocks, styles, { lookup: files, onOpenLink, onOpenFile, renderCard, theme: renderCard === null && !debriefButtons ? null : theme })}
    </View>
  );
}
