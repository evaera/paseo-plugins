/**
 * A comment thread drawn with React Native: the native diff's inline threads,
 * the file- and review-level lists on every platform, and the composer that
 * starts one. The web editor draws its inline threads as DOM instead
 * (`editor/threads.ts`), to the same design, after Crit's comment card: a
 * header with the author and small icon actions, the body, the replies, and a
 * compact "Reply..." field that grows on focus. A resolved thread folds to one
 * line and opens when pressed.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Markdown, TextInput } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import type { Author, Comment, Reply } from "../shared/review";
import { authorLabel, messageOf, rangeLabel, relativeTime } from "./format";
import { Badge, Button, IconButton, MONOSPACE } from "./ui";

export interface ThreadActions {
  reply(commentId: string, body: string): Promise<void>;
  resolve(commentId: string, resolved: boolean): Promise<void>;
  edit(commentId: string, replyId: string | undefined, body: string): Promise<void>;
  remove(commentId: string, replyId: string | undefined): Promise<void>;
  /** An agent's provider, for authors whose comment predates the stored one. */
  agentProvider?(agentId: string): string | undefined;
  /** Opens an agent's chat; absent where the host gives no navigation. */
  openAgent?(agentId: string): void;
}

function useThreadStyles(theme: PluginTheme) {
  const colors = theme.colors;
  return useMemo(
    () => ({
      card: {
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 8,
        backgroundColor: colors.surface1,
        overflow: "hidden" as const,
      },
      drifted: { borderColor: colors.statusWarning },
      resolved: { opacity: 0.8 },
      head: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingLeft: 10,
        paddingRight: 6,
        paddingVertical: 4,
        backgroundColor: colors.surface2,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      },
      headFolded: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingLeft: 10,
        paddingRight: 6,
        paddingVertical: 4,
        backgroundColor: colors.surface2,
      },
      headLeft: { flex: 1, minWidth: 0, flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      icons: { flexDirection: "row" as const, alignItems: "center" as const, gap: 2 },
      author: {
        color: colors.foreground,
        fontWeight: "600" as const,
        fontSize: 11,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 10,
        paddingHorizontal: 7,
      },
      agent: {
        color: colors.accent,
        fontWeight: "600" as const,
        fontSize: 11,
        borderWidth: 1,
        borderColor: colors.accent,
        borderRadius: 10,
        paddingHorizontal: 7,
      },
      ref: { color: colors.accent, fontWeight: "600" as const, fontSize: 12, fontFamily: MONOSPACE },
      meta: { color: colors.foregroundMuted, fontSize: 11 },
      summary: { flex: 1, minWidth: 0, color: colors.foregroundMuted, fontSize: 12 },
      body: { paddingHorizontal: 12, paddingVertical: 8, gap: 6 },
      quote: {
        color: colors.foregroundMuted,
        fontStyle: "italic" as const,
        fontSize: 12,
        borderLeftWidth: 2,
        borderLeftColor: colors.border,
        paddingLeft: 8,
      },
      replies: { borderTopWidth: 1, borderTopColor: colors.border },
      reply: { paddingHorizontal: 12, paddingVertical: 6, gap: 2 },
      replyDivider: { borderTopWidth: 1, borderTopColor: colors.border },
      replyHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      replyForm: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 10, borderTopWidth: 1, borderTopColor: colors.border },
      compactInput: {
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 6,
        paddingHorizontal: 9,
        paddingVertical: 5,
        color: colors.foreground,
        backgroundColor: colors.surface0,
        fontSize: 13,
      },
      input: {
        minHeight: 64,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 6,
        padding: 8,
        color: colors.foreground,
        backgroundColor: colors.surface0,
        fontSize: 13,
      },
      actions: { flexDirection: "row" as const, gap: 6, justifyContent: "flex-end" as const, flexWrap: "wrap" as const },
      error: { color: colors.statusDanger, fontSize: 12, paddingHorizontal: 12 },
    }),
    [colors],
  );
}

/** A text box with a submit and cancel button; used to start, reply to and edit a thread. */
export function Composer({
  theme,
  placeholder,
  submitLabel,
  initial = "",
  onSubmit,
  onCancel,
  autoFocus = false,
}: {
  theme: PluginTheme;
  placeholder: string;
  submitLabel: string;
  initial?: string;
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const styles = useThreadStyles(theme);
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    const body = text.trim();
    if (body === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(body);
      setText("");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 6 }}>
      <TextInput
        style={styles.input}
        value={text}
        onChangeText={setText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.foregroundMuted}
        multiline
        autoFocus={autoFocus}
      />
      {error !== null ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        {onCancel !== undefined ? <Button label="Cancel" theme={theme} onPress={onCancel} /> : null}
        <Button
          label={submitLabel}
          tone="accent"
          theme={theme}
          disabled={busy || text.trim() === ""}
          onPress={() => void submit()}
        />
      </View>
    </View>
  );
}

/** Crit's reply box: one line until focused, then a text area with Cancel and Reply. */
function ReplyBox({ theme, onSubmit }: { theme: PluginTheme; onSubmit: (body: string) => Promise<void> }) {
  const styles = useThreadStyles(theme);
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.replyForm}>
      {open ? (
        <Composer
          theme={theme}
          placeholder="Reply..."
          submitLabel="Reply"
          autoFocus
          onSubmit={async (body) => {
            await onSubmit(body);
            setOpen(false);
          }}
          onCancel={() => setOpen(false)}
        />
      ) : (
        <TextInput
          style={styles.compactInput}
          placeholder="Reply..."
          placeholderTextColor={theme.colors.foregroundMuted}
          value=""
          onFocus={() => setOpen(true)}
          onChangeText={() => setOpen(true)}
        />
      )}
    </View>
  );
}

function AuthorBadge({ author, theme, actions }: { author: Author; theme: PluginTheme; actions?: ThreadActions }) {
  const styles = useThreadStyles(theme);
  const label = authorLabel(author, (agentId) => actions?.agentProvider?.(agentId));
  const agentId = author.kind === "agent" ? author.agentId : undefined;
  const open = actions?.openAgent;
  if (agentId === undefined || open === undefined) {
    return <Text style={author.kind === "agent" ? styles.agent : styles.author}>{label}</Text>;
  }
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={`${author.name}: open this agent`} onPress={() => open(agentId)}>
      <Text style={styles.agent}>{label}</Text>
    </Pressable>
  );
}

/** The trash icon: the first press arms it, the second deletes. */
function DeleteIcon({ what, theme, onDelete }: { what: string; theme: PluginTheme; onDelete: () => void }) {
  const [armed, setArmed] = useState(false);
  return (
    <IconButton
      icon="Trash2"
      label={armed ? `Press again to delete the ${what}` : `Delete ${what}`}
      tone={armed ? "danger" : "default"}
      theme={theme}
      onPress={() => {
        if (!armed) {
          setArmed(true);
          setTimeout(() => setArmed(false), 3000);
          return;
        }
        onDelete();
      }}
    />
  );
}

function ReplyView({
  comment,
  reply,
  theme,
  actions,
  first,
  onError,
}: {
  comment: Comment;
  reply: Reply;
  theme: PluginTheme;
  actions: ThreadActions;
  first: boolean;
  onError: (message: string) => void;
}) {
  const styles = useThreadStyles(theme);
  const [editing, setEditing] = useState(false);
  const human = reply.author.kind === "human";
  return (
    <View style={first ? styles.reply : [styles.reply, styles.replyDivider]}>
      <View style={styles.replyHead}>
        <AuthorBadge author={reply.author} theme={theme} actions={actions} />
        <Text style={[styles.meta, { flex: 1 }]}>{relativeTime(reply.createdAt)}</Text>
        {human && !editing ? (
          <View style={styles.icons}>
            <IconButton icon="Pencil" label="Edit reply" theme={theme} onPress={() => setEditing(true)} />
            <DeleteIcon
              what="reply"
              theme={theme}
              onDelete={() => void actions.remove(comment.id, reply.id).catch((cause: unknown) => onError(messageOf(cause)))}
            />
          </View>
        ) : null}
      </View>
      {editing ? (
        <Composer
          theme={theme}
          placeholder="Edit reply"
          submitLabel="Save"
          initial={reply.body}
          autoFocus
          onSubmit={async (body) => {
            await actions.edit(comment.id, reply.id, body);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <Markdown>{reply.body}</Markdown>
      )}
    </View>
  );
}

function summaryLine(body: string): string {
  const first = body.split("\n").find((line) => line.trim() !== "") ?? "";
  return first.replace(/[#>*_`]/g, "").trim();
}

/** One thread: the comment, its replies, and what the reviewer can do with it. */
export function ThreadView({
  comment,
  theme,
  actions,
  showRange = true,
}: {
  comment: Comment;
  theme: PluginTheme;
  actions: ThreadActions;
  showRange?: boolean;
}) {
  const styles = useThreadStyles(theme);
  const [editing, setEditing] = useState(false);
  const [folded, setFolded] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const human = comment.author.kind === "human";
  const range = rangeLabel(comment);
  const isFolded = folded ?? comment.resolved;
  const cardStyle = [styles.card, comment.drifted ? styles.drifted : null, comment.resolved ? styles.resolved : null];

  function run(action: Promise<void>) {
    setError(null);
    action.catch((cause: unknown) => setError(messageOf(cause)));
  }

  const resolveIcon = (
    <IconButton
      icon={comment.resolved ? "RotateCcw" : "Check"}
      label={comment.resolved ? "Reopen thread" : "Resolve thread"}
      text={comment.resolved ? "Resolved" : "Resolve"}
      active={comment.resolved}
      theme={theme}
      onPress={() => run(actions.resolve(comment.id, !comment.resolved))}
    />
  );

  const headLeft = (
    <View style={styles.headLeft}>
      <Icon name={isFolded ? "ChevronRight" : "ChevronDown"} size={14} color={theme.colors.foregroundMuted} />
      <AuthorBadge author={comment.author} theme={theme} actions={actions} />
      {showRange && range !== "" ? <Text style={styles.ref}>{range}</Text> : null}
      <Text style={styles.meta}>{relativeTime(comment.createdAt)}</Text>
      {comment.drifted ? <Badge text="drifted" tone="warning" theme={theme} /> : null}
      {isFolded ? (
        <Text style={styles.summary} numberOfLines={1}>
          {summaryLine(comment.body)}
        </Text>
      ) : null}
    </View>
  );

  if (isFolded) {
    return (
      <View style={cardStyle}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Expand thread"
          style={styles.headFolded}
          onPress={() => setFolded(false)}
        >
          {headLeft}
          <View style={styles.icons}>{resolveIcon}</View>
        </Pressable>
        {error !== null ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    );
  }

  return (
    <View style={cardStyle}>
      <View style={styles.head}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Collapse thread"
          style={{ flex: 1, minWidth: 0 }}
          onPress={() => setFolded(true)}
        >
          {headLeft}
        </Pressable>
        <View style={styles.icons}>
          {resolveIcon}
          {human && !editing ? <IconButton icon="Pencil" label="Edit comment" theme={theme} onPress={() => setEditing(true)} /> : null}
          {human ? <DeleteIcon what="thread" theme={theme} onDelete={() => run(actions.remove(comment.id, undefined))} /> : null}
        </View>
      </View>
      <View style={styles.body}>
        {comment.quote ? <Text style={styles.quote}>{comment.quote}</Text> : null}
        {editing ? (
          <Composer
            theme={theme}
            placeholder="Edit comment"
            submitLabel="Save"
            initial={comment.body}
            autoFocus
            onSubmit={async (body) => {
              await actions.edit(comment.id, undefined, body);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <Markdown>{comment.body}</Markdown>
        )}
      </View>
      {comment.replies.length > 0 ? (
        <View style={styles.replies}>
          {comment.replies.map((reply, index) => (
            <ReplyView
              key={reply.id}
              comment={comment}
              reply={reply}
              theme={theme}
              actions={actions}
              first={index === 0}
              onError={setError}
            />
          ))}
        </View>
      ) : null}
      {error !== null ? <Text style={styles.error}>{error}</Text> : null}
      <ReplyBox theme={theme} onSubmit={(body) => actions.reply(comment.id, body)} />
    </View>
  );
}
