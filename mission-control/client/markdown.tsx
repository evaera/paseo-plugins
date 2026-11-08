/**
 * A small renderer for the Markdown an agent writes.
 *
 * A client bundle may import only the modules the host provides, so no
 * Markdown library is reachable, and the host has no renderer of its own to
 * lend. This covers what a Mission Control agent's reply actually uses — headings,
 * lists, fenced code, quotes, rules, pipe tables, and bold, code, links and
 * images inline, with the files it names linked (`./file-links`) — and renders
 * anything else as a plain paragraph. It began as a trimmed copy of
 * `github-board/client/markdown.tsx`, without the HTML and `<details>` an issue
 * body needs and an agent's reply does not; there is no workspace root to share
 * one from.
 *
 * Images are taken out of the text they sit in and drawn under it, a block's
 * images together as one gallery (`./markdown-image`): React Native cannot put a
 * view inside a line of text, and an agent's images are a set of screenshots,
 * not icons in a sentence.
 *
 * Single newlines break lines, so a list the agent wrapped by hand keeps its
 * shape instead of reflowing.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";

import { revealFile } from "../shared/files";
import { DebriefEmbed } from "./debrief-embed";
import { inlineTokens, type FileLookup, type InlineOptions } from "./file-links";
import { errorText } from "./format";
import { ImageGallery, type ImageRef } from "./markdown-image";
import { parseMarkdown, type Block } from "./markdown-parse";
import { RunEmbed } from "./run-embed";
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
  options: InlineOptions;
  onOpenLink: (url: string) => void;
  onOpenFile: ((path: string) => void) | null;
  /** Shows a project file in the file manager; null where file links are off. */
  onRevealFile: ((path: string) => void) | null;
  renderCard: ((ref: string) => ReactNode) | null;
  /** The theme for a Debrief embed's button; null where a button has no board to act on. */
  theme: PluginTheme | null;
  /** Draws `[[run: …]]` embeds as run buttons, with this theme; null draws them as code. */
  runTheme: PluginTheme | null;
  imageTheme: PluginTheme;
  /** The tallest a lone image is drawn; a gallery's tiles are shorter. */
  imageHeight: number;
  /** Whether a local image can be read: false for a worker on another host. */
  localImages: boolean;
}

/** One block's inline text as nodes for a `Text`, and the images taken out of it. */
function renderInline(text: string, styles: MarkdownStyles, context: InlineContext): { nodes: ReactNode[]; images: ImageRef[] } {
  // `.map` rather than a loop, because a link's press handler closes over its
  // target and a closure made in a `for…of` body captures the binding's final
  // value under Hermes.
  const { onOpenFile, onRevealFile } = context;
  const lookup = onOpenFile === null ? noFiles : context.lookup;
  const tokens = inlineTokens(text, lookup, context.options);
  const images: ImageRef[] = tokens.flatMap((token) => (token.kind === "image" ? [{ alt: token.alt, src: token.src }] : []));
  const textual = tokens.filter((token) => token.kind !== "image");
  // A line that held only images would otherwise leave its line breaks behind as an empty paragraph.
  const blank = textual.every((token) => token.kind === "text" && token.text.trim() === "");
  const nodes = blank
    ? []
    : textual.map((token, index) => {
        const bold = "bold" in token && token.bold ? styles.bold : null;
        switch (token.kind) {
          case "text":
            return bold === null ? (
              token.text
            ) : (
              <Text key={index} style={bold}>
                {token.text}
              </Text>
            );
          case "code":
            return (
              <Text key={index} style={[styles.inlineCode, bold]}>
                {token.text}
              </Text>
            );
          case "file":
            return (
              <Text
                key={index}
                accessibilityRole="link"
                accessibilityHint={token.where === "home" ? `Opens ${token.path} in Files` : `Shows ${token.path} in the file manager`}
                style={[token.code ? styles.inlineCode : null, styles.link, bold]}
                onPress={() => (token.where === "home" ? onOpenFile?.(token.path) : onRevealFile?.(token.path))}
              >
                {token.text}
              </Text>
            );
          case "link":
            return (
              <Text
                key={index}
                accessibilityRole="link"
                style={[token.code ? styles.inlineCode : null, styles.link, bold]}
                onPress={() => context.onOpenLink(token.url)}
              >
                {token.text}
              </Text>
            );
          default:
            return null;
        }
      });
  return { nodes, images };
}

/**
 * A block of inline text in `style`, with its images in a gallery under it; a block of nothing but
 * images is the gallery alone. `compact` is a table cell's smaller tiles.
 */
function renderRich(
  key: string | number,
  text: string,
  style: object | object[],
  styles: MarkdownStyles,
  context: InlineContext,
  options: { selectable?: boolean; compact?: boolean; role?: "header" } = {},
): ReactNode {
  const { nodes, images } = renderInline(text, styles, context);
  const line = (
    <Text key={images.length === 0 ? key : "text"} selectable={options.selectable} accessibilityRole={options.role} style={style}>
      {nodes}
    </Text>
  );
  if (images.length === 0) return line;
  return (
    <View key={key} style={{ gap: 8 }}>
      {nodes.length === 0 ? null : line}
      <ImageGallery
        images={images}
        theme={context.imageTheme}
        maxHeight={options.compact === true ? Math.min(160, context.imageHeight) : context.imageHeight}
        tileMin={options.compact === true ? 100 : 200}
        localFiles={context.localImages}
      />
    </View>
  );
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
        return renderRich(index, block.text, block.level <= 2 ? styles.headingLarge : styles.heading, styles, context, { role: "header" });
      case "list":
        return (
          <View key={index}>
            {block.items.map((item, itemIndex) => (
              <View key={itemIndex} style={[styles.listRow, { paddingLeft: item.depth * 14 }]}>
                <Text style={styles.listMarker}>{item.marker}</Text>
                <View style={styles.listText}>{renderRich(itemIndex, item.text, styles.paragraph, styles, context, { selectable: true })}</View>
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
      case "run":
        // A button only in Mission Control's own words; anywhere else, the command as code, never runnable.
        return context.runTheme === null ? (
          <View key={index} style={styles.codeBlock}>
            <Text selectable style={styles.codeText}>
              {block.project === null ? block.command : `${block.project} :: ${block.command}`}
            </Text>
          </View>
        ) : (
          <RunEmbed key={index} project={block.project} command={block.command} theme={context.runTheme} />
        );
      case "table":
        return (
          <View key={index} style={styles.table}>
            {[block.header, ...block.rows].map((cells, rowIndex) => (
              <View key={rowIndex} style={styles.tableRow}>
                {cells.map((cell, cellIndex) => (
                  <View key={cellIndex} style={styles.tableCell}>
                    {renderRich(
                      cellIndex,
                      cell,
                      rowIndex === 0 ? [styles.paragraph, styles.tableHeader] : styles.paragraph,
                      styles,
                      context,
                      { selectable: true, compact: true },
                    )}
                  </View>
                ))}
              </View>
            ))}
          </View>
        );
      default:
        return renderRich(index, block.text, styles.paragraph, styles, context, { selectable: true });
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
  runButtons = false,
  baseDir,
  localImages = true,
  imageHeight = 360,
}: {
  source: string;
  theme: PluginTheme;
  fontSize?: number;
  /** Chat spacing: a looser line height and more room between blocks. */
  relaxed?: boolean;
  onOpenLink: (url: string) => void;
  /**
   * Which paths the text names are files in the home or a project, from `mission-control.files.find`:
   * see `./file-links`. None are linked without `onOpenFile`, which opens a home file in Files; a
   * project file is shown in the file manager.
   */
  files?: FileLookup;
  onOpenFile?: ((path: string) => void) | null;
  /** The home-relative folder relative links and images are read from: the file's own, in the Files preview. */
  baseDir?: string;
  /** False where local images cannot be read: a worker on another host. */
  localImages?: boolean;
  /** The tallest a lone image is drawn. */
  imageHeight?: number;
  /** Draws a `[[card: …]]` embed; without it the embed reads as its id. */
  renderCard?: ((ref: string) => ReactNode) | null;
  /** Draws `[[debrief]]` embeds as buttons; on wherever `renderCard` is given, and in a worker's transcript. */
  debriefButtons?: boolean;
  /** Draws `[[run: …]]` embeds as buttons that run their command. Only for Mission Control's own replies in the chat. */
  runButtons?: boolean;
}) {
  const styles = useMarkdownStyles(theme, fontSize, relaxed);
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  const reveal = useRpc(revealFile);
  const toast = useToast();
  return (
    <View style={{ gap: relaxed ? 12 : 6 }}>
      {renderBlocks(blocks, styles, {
        lookup: files,
        options: baseDir === undefined ? {} : { baseDir },
        onOpenLink,
        onOpenFile,
        onRevealFile:
          onOpenFile === null
            ? null
            : (path) => {
                reveal({ path }).catch((caught: unknown) => toast.error(errorText(caught)));
              },
        imageTheme: theme,
        imageHeight,
        localImages,
        renderCard,
        theme: renderCard === null && !debriefButtons ? null : theme,
        runTheme: runButtons ? theme : null,
      })}
    </View>
  );
}
