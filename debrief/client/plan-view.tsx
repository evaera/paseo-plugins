/**
 * Plan review, after Plannotator's annotation mode. The plan is drawn block
 * by block with the host `Markdown`; the reviewer annotates a block (a press
 * on iOS and Android, the block's button on web) or, on web, a selected span
 * inside one, as a comment, a deletion or a one-tap quick label. Annotations
 * stay drafts until a decision sends them together, because the agent is
 * waiting on the verdict. A version picker and a diff against the previous
 * version show what changed between rounds.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Loading, Markdown, Modal, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { z } from "zod";

import {
  annotatePlan,
  DEFAULT_QUICK_LABELS,
  decidePlan,
  loadPlan,
  type PlanAnnotation,
  type PlanBlock,
  updatePlanAnnotation,
} from "../shared/plan";
import { authorLabel, messageOf, relativeTime } from "./format";
import {
  annotationsByBlock,
  clip,
  draftAnnotations,
  labelNames,
  locateSpan,
  planDiff,
  type PlanDiffPart,
  sortAnnotations,
  sourceLabel,
  statusLabel,
} from "./plan-model";
import { Composer } from "./thread";
import { Badge, Button, IconButton, Segmented } from "./ui";
import { watchSelection } from "./web";

const POLL_MS = 4000;

type Loaded = z.output<typeof loadPlan.output>;

/** What the reviewer has picked to annotate, before choosing how. */
interface Pending {
  key: string;
  blockId?: string;
  startLine?: number;
  endLine?: number;
  startOffset?: number;
  endOffset?: number;
  originalText: string;
  inDiff: boolean;
}

type AnnotationInput = z.input<typeof annotatePlan.input>["annotation"];

function pendingFromBlock(block: PlanBlock, selected?: string): Pending {
  const span = selected !== undefined ? locateSpan(block.text, selected) : null;
  const base = {
    key: `${block.id}:${span?.start ?? "all"}:${span?.end ?? "all"}`,
    blockId: block.id,
    startLine: block.startLine,
    endLine: block.endLine,
    inDiff: false,
  };
  if (span !== null) {
    return { ...base, startOffset: span.start, endOffset: span.end, originalText: block.text.slice(span.start, span.end) };
  }
  return { ...base, originalText: selected?.trim() || block.text };
}

function pendingFromPart(part: PlanDiffPart, index: number): Pending {
  return {
    key: `diff:${index}`,
    ...(part.startLine !== undefined ? { startLine: part.startLine } : {}),
    ...(part.endLine !== undefined ? { endLine: part.endLine } : {}),
    originalText: part.text.trim(),
    inDiff: true,
  };
}

function toInput(pending: Pending, type: "comment" | "deletion", body: string, labels: string[]): AnnotationInput {
  return {
    type,
    ...(pending.blockId !== undefined ? { blockId: pending.blockId } : {}),
    ...(pending.startLine !== undefined ? { startLine: pending.startLine } : {}),
    ...(pending.endLine !== undefined ? { endLine: pending.endLine } : {}),
    ...(pending.startOffset !== undefined ? { startOffset: pending.startOffset } : {}),
    ...(pending.endOffset !== undefined ? { endOffset: pending.endOffset } : {}),
    originalText: pending.originalText,
    body,
    labels,
    inDiff: pending.inDiff,
  };
}

function usePlanStyles(theme: PluginTheme, compact: boolean) {
  const colors = theme.colors;
  return useMemo(
    () => ({
      root: { flex: 1, minHeight: 0, backgroundColor: colors.surface0 },
      header: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        backgroundColor: colors.surface1,
      },
      title: { color: colors.foreground, fontSize: 15, fontWeight: "700" as const, flexShrink: 1 },
      muted: { color: colors.foregroundMuted, fontSize: 12 },
      spacer: { flex: 1 },
      body: { flex: 1, minHeight: 0, flexDirection: compact ? ("column" as const) : ("row" as const) },
      plan: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, minHeight: 0 },
      planContent: { padding: 16, gap: 4 },
      side: compact
        ? { borderTopWidth: 1, borderTopColor: colors.border, maxHeight: "45%" as const }
        : { width: 340, flexGrow: 0, flexShrink: 0, borderLeftWidth: 1, borderLeftColor: colors.border },
      sideContent: { padding: 12, gap: 10 },
      block: {
        flexDirection: "row" as const,
        alignItems: "flex-start" as const,
        gap: 6,
        paddingLeft: 10,
        paddingRight: 4,
        paddingVertical: 2,
        borderLeftWidth: 3,
        borderLeftColor: "transparent",
        borderRadius: 4,
      },
      blockBody: { flex: 1, minWidth: 0 },
      pending: {
        marginLeft: 13,
        marginVertical: 6,
        padding: 10,
        gap: 8,
        borderWidth: 1,
        borderColor: colors.accent,
        borderRadius: 8,
        backgroundColor: colors.surface1,
      },
      quote: {
        color: colors.foregroundMuted,
        fontStyle: "italic" as const,
        fontSize: 12,
        borderLeftWidth: 2,
        borderLeftColor: colors.border,
        paddingLeft: 8,
      },
      chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      chip: {
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 999,
        paddingHorizontal: 9,
        paddingVertical: 3,
        backgroundColor: colors.surface0,
      },
      chipOn: {
        borderWidth: 1,
        borderColor: colors.accent,
        borderRadius: 999,
        paddingHorizontal: 9,
        paddingVertical: 3,
        backgroundColor: colors.accent,
      },
      chipText: { color: colors.foreground, fontSize: 12 },
      chipTextOn: { color: colors.accentForeground, fontSize: 12 },
      row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6, alignItems: "center" as const },
      card: {
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 8,
        backgroundColor: colors.surface1,
        padding: 10,
        gap: 6,
      },
      cardSent: {
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 8,
        backgroundColor: colors.surface1,
        padding: 10,
        gap: 6,
        opacity: 0.7,
      },
      cardHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
      reply: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 6, gap: 2 },
      author: { color: colors.foreground, fontSize: 12, fontWeight: "600" as const },
      section: { color: colors.foregroundMuted, fontSize: 11, fontWeight: "700" as const, letterSpacing: 0.5 },
      added: {
        borderLeftWidth: 3,
        borderLeftColor: colors.statusSuccess,
        backgroundColor: colors.surface1,
        paddingLeft: 10,
        paddingVertical: 4,
        marginVertical: 2,
      },
      removed: {
        borderLeftWidth: 3,
        borderLeftColor: colors.statusDanger,
        backgroundColor: colors.surface2,
        paddingLeft: 10,
        paddingVertical: 4,
        marginVertical: 2,
        opacity: 0.75,
      },
      same: { paddingLeft: 13, paddingVertical: 2, opacity: 0.85 },
      decision: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 8,
        alignItems: "center" as const,
        justifyContent: "flex-end" as const,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderTopWidth: 1,
        borderTopColor: colors.border,
        backgroundColor: colors.surface1,
      },
      error: { color: colors.statusDanger, padding: 12 },
    }),
    [colors, compact],
  );
}

function BlockView({
  block,
  annotations,
  selected,
  web,
  theme,
  styles,
  onPick,
}: {
  block: PlanBlock;
  annotations: readonly PlanAnnotation[];
  selected: boolean;
  web: boolean;
  theme: PluginTheme;
  styles: ReturnType<typeof usePlanStyles>;
  onPick: (block: PlanBlock, selectedText?: string) => void;
}) {
  const ref = useRef<View>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  useEffect(() => {
    if (!web) return;
    return watchSelection(ref.current, (text) => pick.current(block, text));
  }, [web, block]);
  const colors = theme.colors;
  const deleted = annotations.some((annotation) => annotation.type === "deletion");
  const rule = deleted ? colors.statusDanger : annotations.length > 0 ? colors.accent : "transparent";
  const style = [styles.block, { borderLeftColor: rule }, selected ? { backgroundColor: colors.surface2 } : null];
  const content = (
    <View style={[styles.blockBody, deleted ? { opacity: 0.55 } : null]}>
      <Markdown>{block.text}</Markdown>
    </View>
  );
  if (!web) {
    return (
      <Pressable accessibilityRole="button" accessibilityHint="Annotate this block" style={style} onPress={() => onPick(block)}>
        {content}
        {annotations.length > 0 ? <Badge text={String(annotations.length)} tone="accent" theme={theme} /> : null}
      </Pressable>
    );
  }
  return (
    <View ref={ref} style={style}>
      {content}
      {annotations.length > 0 ? <Badge text={String(annotations.length)} tone="accent" theme={theme} /> : null}
      <IconButton icon="MessageSquarePlus" label="Annotate this block" theme={theme} onPress={() => onPick(block)} />
    </View>
  );
}

function PendingPanel({
  pending,
  theme,
  styles,
  onCreate,
  onCancel,
}: {
  pending: Pending;
  theme: PluginTheme;
  styles: ReturnType<typeof usePlanStyles>;
  onCreate: (type: "comment" | "deletion", body: string, labels: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [writing, setWriting] = useState(false);
  const [labels, setLabels] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const run = (action: Promise<void>) => {
    setError(null);
    action.catch((cause: unknown) => setError(messageOf(cause)));
  };
  return (
    <View style={styles.pending}>
      <Text style={styles.quote} numberOfLines={4}>
        {clip(pending.originalText, 240)}
      </Text>
      <View style={styles.chips}>
        {DEFAULT_QUICK_LABELS.map((label) => {
          const on = labels.includes(label.id);
          return (
            <Pressable
              key={label.id}
              accessibilityRole="button"
              accessibilityHint={writing ? "Adds this label to the comment" : "Adds a comment with this label"}
              style={on ? styles.chipOn : styles.chip}
              onPress={() => {
                if (writing) setLabels(on ? labels.filter((id) => id !== label.id) : [...labels, label.id]);
                else run(onCreate("comment", "", [label.id]));
              }}
            >
              <Text style={on ? styles.chipTextOn : styles.chipText}>{label.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {writing ? (
        <Composer
          theme={theme}
          placeholder="Comment on this part of the plan"
          submitLabel="Add comment"
          autoFocus
          onSubmit={(body) => onCreate("comment", body, labels)}
          onCancel={() => setWriting(false)}
        />
      ) : (
        <View style={styles.row}>
          <Button label="Comment" icon="MessageSquarePlus" tone="accent" theme={theme} onPress={() => setWriting(true)} />
          <Button label="Delete this" icon="Strikethrough" tone="danger" theme={theme} onPress={() => run(onCreate("deletion", "", []))} />
          <Button label="Cancel" tone="quiet" theme={theme} onPress={onCancel} />
        </View>
      )}
      {error !== null ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
    </View>
  );
}

function AnnotationCard({
  annotation,
  theme,
  styles,
  onUpdate,
}: {
  annotation: PlanAnnotation;
  theme: PluginTheme;
  styles: ReturnType<typeof usePlanStyles>;
  onUpdate: (patch: { body?: string; delete?: boolean; reply?: string }) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [replying, setReplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sent = annotation.sentInVersion !== undefined;
  const kind =
    annotation.type === "global" ? "Overall" : annotation.type === "deletion" ? "Delete" : annotation.inDiff ? "In diff" : "Comment";
  const run = (action: Promise<void>) => {
    setError(null);
    action.catch((cause: unknown) => setError(messageOf(cause)));
  };
  return (
    <View style={sent ? styles.cardSent : styles.card}>
      <View style={styles.cardHead}>
        <Badge text={kind} tone={annotation.type === "deletion" ? "danger" : "accent"} theme={theme} />
        {labelNames(annotation.labels, DEFAULT_QUICK_LABELS).map((name) => (
          <Badge key={name} text={name} theme={theme} />
        ))}
        <Text style={[styles.muted, { flex: 1 }]}>{sent ? `sent with v${annotation.sentInVersion}` : "draft"}</Text>
        {!sent && !editing && annotation.author.kind === "human" ? (
          <IconButton icon="Pencil" label="Edit annotation" theme={theme} onPress={() => setEditing(true)} />
        ) : null}
        {!sent ? (
          <IconButton icon="Trash2" label="Delete annotation" theme={theme} onPress={() => run(onUpdate({ delete: true }))} />
        ) : null}
      </View>
      {annotation.originalText !== "" && annotation.type !== "global" ? (
        <Text style={styles.quote} numberOfLines={3}>
          {clip(annotation.originalText)}
        </Text>
      ) : null}
      {editing ? (
        <Composer
          theme={theme}
          placeholder="Edit"
          submitLabel="Save"
          initial={annotation.body}
          autoFocus
          onSubmit={async (body) => {
            await onUpdate({ body });
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : annotation.body !== "" ? (
        <Markdown>{annotation.body}</Markdown>
      ) : null}
      {annotation.replies.map((reply) => (
        <View key={reply.id} style={styles.reply}>
          <Text style={styles.author}>{`${authorLabel(reply.author)} · ${relativeTime(reply.createdAt)}`}</Text>
          <Markdown>{reply.body}</Markdown>
        </View>
      ))}
      {replying ? (
        <Composer
          theme={theme}
          placeholder="Reply..."
          submitLabel="Reply"
          autoFocus
          onSubmit={async (reply) => {
            await onUpdate({ reply });
            setReplying(false);
          }}
          onCancel={() => setReplying(false)}
        />
      ) : annotation.replies.length > 0 || sent ? (
        <View style={styles.row}>
          <Button label="Reply" icon="Reply" tone="quiet" theme={theme} onPress={() => setReplying(true)} />
        </View>
      ) : null}
      {error !== null ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
    </View>
  );
}

export function PlanView({
  workspaceId,
  planId,
  theme,
  platform,
  compact,
}: {
  workspaceId: string;
  planId: string;
  theme: PluginTheme;
  platform: "ios" | "android" | "web";
  compact: boolean;
}) {
  const load = useRpc(loadPlan);
  const annotate = useRpc(annotatePlan);
  const update = useRpc(updatePlanAnnotation);
  const decide = useRpc(decidePlan);
  const toast = useToast();
  const styles = usePlanStyles(theme, compact);
  const web = platform === "web";

  const [version, setVersion] = useState<number | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [globalComposer, setGlobalComposer] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deciding, setDeciding] = useState(false);

  const reload = useCallback(async () => {
    try {
      const next = await load(version === null ? { workspaceId, planId } : { workspaceId, planId, version });
      setData(next);
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [load, workspaceId, planId, version]);

  useEffect(() => {
    setPending(null);
    void reload();
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);

  const byBlock = useMemo(() => annotationsByBlock(data?.annotations ?? []), [data]);
  const sorted = useMemo(() => sortAnnotations(data?.annotations ?? [], data?.blocks ?? []), [data]);
  const drafts = useMemo(() => draftAnnotations(data?.annotations ?? []), [data]);
  const diff = useMemo(
    () => (data?.previousMarkdown != null ? planDiff(data.previousMarkdown, data.markdown) : null),
    [data],
  );

  if (data === null) {
    return <View style={styles.root}>{error !== null ? <Text style={styles.error}>{error}</Text> : <Loading />}</View>;
  }

  const latest = data.version === data.plan.versions;
  const decided = data.plan.status !== "pending";

  const create = async (type: "comment" | "deletion", body: string, labels: string[]) => {
    if (pending === null) return;
    await annotate({ workspaceId, planId, annotation: toInput(pending, type, body, labels) });
    setPending(null);
    await reload();
  };
  const onUpdate = (annotationId: string) => async (patch: { body?: string; delete?: boolean; reply?: string }) => {
    await update({ workspaceId, planId, annotationId, ...patch });
    await reload();
  };
  const runDecision = (decision: "approve" | "approve-with-notes" | "feedback") => {
    setConfirming(false);
    setDeciding(true);
    decide({ workspaceId, planId, decision })
      .then(() => {
        toast.show(decision === "feedback" ? "Feedback sent to the agent" : "Plan approved", { variant: "success" });
        return reload();
      })
      .catch((cause: unknown) => toast.error(messageOf(cause)))
      .finally(() => setDeciding(false));
  };

  const pick = (block: PlanBlock, selectedText?: string) => {
    if (!latest) {
      toast.show("Annotate the latest version");
      return;
    }
    setPending(pendingFromBlock(block, selectedText));
  };

  const planBody = showDiff && diff !== null ? (
    <View>
      <Text style={[styles.muted, { marginBottom: 8 }]}>{`+${diff.added} -${diff.removed} lines since v${data.version - 1}`}</Text>
      {diff.parts.map((part, index) => {
        const key = `diff:${index}`;
        const style = part.kind === "added" ? styles.added : part.kind === "removed" ? styles.removed : styles.same;
        const body = <Markdown>{part.text}</Markdown>;
        return (
          <View key={key}>
            {part.kind === "same" || !latest ? (
              <View style={style}>{body}</View>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityHint="Comment on this change"
                style={style}
                onPress={() => setPending(pendingFromPart(part, index))}
              >
                {body}
              </Pressable>
            )}
            {pending?.key === key ? (
              <PendingPanel pending={pending} theme={theme} styles={styles} onCreate={create} onCancel={() => setPending(null)} />
            ) : null}
          </View>
        );
      })}
    </View>
  ) : (
    data.blocks.map((block) => (
      <View key={block.id}>
        <BlockView
          block={block}
          annotations={byBlock.get(block.id) ?? []}
          selected={pending?.blockId === block.id}
          web={web}
          theme={theme}
          styles={styles}
          onPick={pick}
        />
        {pending !== null && pending.blockId === block.id && !pending.inDiff ? (
          <PendingPanel
            key={pending.key}
            pending={pending}
            theme={theme}
            styles={styles}
            onCreate={create}
            onCancel={() => setPending(null)}
          />
        ) : null}
      </View>
    ))
  );

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Icon name="ClipboardList" size={16} color={theme.colors.accent} />
        <Text style={styles.title} numberOfLines={1}>
          {data.plan.title}
        </Text>
        <Badge
          text={statusLabel(data.plan.status)}
          tone={data.plan.status === "approved" ? "success" : data.plan.status === "changes-requested" ? "warning" : "accent"}
          theme={theme}
        />
        <Text style={styles.muted} numberOfLines={1}>
          {sourceLabel(data.plan.source)}
        </Text>
        <View style={styles.spacer} />
        <Button
          label="Older version"
          icon="ChevronLeft"
          showLabel={false}
          disabled={data.version <= 1}
          theme={theme}
          onPress={() => setVersion(data.version - 1)}
        />
        <Text style={styles.muted}>{`v${data.version} of ${data.plan.versions}`}</Text>
        <Button
          label="Newer version"
          icon="ChevronRight"
          showLabel={false}
          disabled={latest}
          theme={theme}
          onPress={() => setVersion(data.version + 1 >= data.plan.versions ? null : data.version + 1)}
        />
        {diff !== null ? (
          <Segmented
            value={showDiff ? "diff" : "plan"}
            options={[
              { value: "plan", label: "Plan" },
              { value: "diff", label: `Diff +${diff.added} -${diff.removed}` },
            ]}
            theme={theme}
            onChange={(next) => {
              setShowDiff(next === "diff");
              setPending(null);
            }}
          />
        ) : null}
      </View>
      {error !== null ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.body}>
        <ScrollView style={styles.plan} contentContainerStyle={styles.planContent}>
          {web && latest && !showDiff ? (
            <Text style={[styles.muted, { marginBottom: 8 }]}>Select text in a block to annotate it, or use a block's button.</Text>
          ) : null}
          {!web && latest ? <Text style={[styles.muted, { marginBottom: 8 }]}>Press a block to annotate it.</Text> : null}
          {planBody}
        </ScrollView>
        <ScrollView style={styles.side} contentContainerStyle={styles.sideContent}>
          <Text style={styles.section}>{`ANNOTATIONS (${drafts.length} unsent)`}</Text>
          {latest ? (
            globalComposer ? (
              <Composer
                theme={theme}
                placeholder="A comment on the plan as a whole"
                submitLabel="Add"
                autoFocus
                onSubmit={async (body) => {
                  await annotate({
                    workspaceId,
                    planId,
                    annotation: { type: "global", originalText: "", body, labels: [], inDiff: false },
                  });
                  setGlobalComposer(false);
                  await reload();
                }}
                onCancel={() => setGlobalComposer(false)}
              />
            ) : (
              <View style={styles.row}>
                <Button label="Comment on the plan" icon="MessageSquarePlus" theme={theme} onPress={() => setGlobalComposer(true)} />
              </View>
            )
          ) : null}
          {sorted.length === 0 ? <Text style={styles.muted}>No annotations yet.</Text> : null}
          {sorted.map((annotation) => (
            <AnnotationCard
              key={annotation.id}
              annotation={annotation}
              theme={theme}
              styles={styles}
              onUpdate={onUpdate(annotation.id)}
            />
          ))}
        </ScrollView>
      </View>
      {latest ? (
        <View style={styles.decision}>
          <Text style={[styles.muted, styles.spacer]}>
            {decided
              ? `This version was ${statusLabel(data.plan.status)}.`
              : drafts.length > 0
                ? `${drafts.length} annotation${drafts.length === 1 ? "" : "s"} will be sent with your decision.`
                : "The agent is waiting for your decision."}
          </Text>
          <Button
            label="Send feedback"
            icon="Send"
            disabled={deciding || drafts.length === 0}
            theme={theme}
            onPress={() => runDecision("feedback")}
          />
          <Button
            label="Approve with notes"
            disabled={deciding || drafts.length === 0}
            theme={theme}
            onPress={() => runDecision("approve-with-notes")}
          />
          <Button
            label="Approve"
            icon="CircleCheck"
            tone="accent"
            disabled={deciding}
            theme={theme}
            onPress={() => (drafts.length > 0 ? setConfirming(true) : runDecision("approve"))}
          />
        </View>
      ) : null}
      <Modal title="Approve without your notes?" open={confirming} onOpenChange={setConfirming}>
        <Modal.Content>
          <Text style={{ color: theme.colors.foreground }}>
            {`You have ${drafts.length} unsent annotation${drafts.length === 1 ? "" : "s"}. A plain approval does not send them.`}
          </Text>
          <View style={styles.row}>
            <Button label="Approve with notes" tone="accent" theme={theme} onPress={() => runDecision("approve-with-notes")} />
            <Button label="Approve without them" theme={theme} onPress={() => runDecision("approve")} />
            <Button label="Cancel" tone="quiet" theme={theme} onPress={() => setConfirming(false)} />
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}
