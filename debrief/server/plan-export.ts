/**
 * Plan feedback as the agent reads it: a port of Plannotator's
 * `exportAnnotations` (`packages/ui/utils/parser.ts`, MIT OR Apache-2.0).
 *
 * The format is Plannotator's, so an agent that has seen Plannotator feedback
 * reads this the same way: "# Plan Feedback", a count, one numbered `##`
 * entry per annotation in document order with its source lines, deletions as
 * "Remove this" over a fenced quote, quick labels in brackets with their tip,
 * replies nested under their entry, and a label tally at the end. Image
 * attachments, page groups, element context and question blocks have no
 * counterpart here and are not ported.
 */
import { DEFAULT_QUICK_LABELS, type PlanAnnotation, type PlanBlock, type QuickLabel } from "../shared/plan";
import { blockLineLabel } from "./plan-blocks";

export const NO_CHANGES = "No changes detected.";

function quoteLines(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function lineLabel(blocks: readonly PlanBlock[], annotation: PlanAnnotation): string | null {
  if (annotation.type === "global" || annotation.inDiff) return null;
  const block = blocks.find((candidate) => candidate.id === annotation.blockId);
  if (block !== undefined) return blockLineLabel(block);
  if (annotation.startLine === undefined) return null;
  return blockLineLabel({ startLine: annotation.startLine, endLine: annotation.endLine ?? annotation.startLine });
}

/** Document order: by block, then offset; globals first, diff-view comments last. */
function sortInDocumentOrder(annotations: readonly PlanAnnotation[], blocks: readonly PlanBlock[]): PlanAnnotation[] {
  const order = new Map(blocks.map((block, index) => [block.id, index]));
  const rank = (annotation: PlanAnnotation) => (annotation.inDiff ? 1 : 0);
  return [...annotations].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const byBlock = (order.get(a.blockId ?? "") ?? -1) - (order.get(b.blockId ?? "") ?? -1);
    if (byBlock !== 0) return byBlock;
    return (a.startOffset ?? 0) - (b.startOffset ?? 0);
  });
}

function labelsOf(annotation: PlanAnnotation, quickLabels: readonly QuickLabel[]): QuickLabel[] {
  return annotation.labels
    .map((id) => quickLabels.find((label) => label.id === id) ?? { id, label: id, tip: "" })
    .filter((label, index, all) => all.findIndex((other) => other.id === label.id) === index);
}

function entry(annotation: PlanAnnotation, labels: readonly QuickLabel[], subject: string): string {
  const tips = labels.filter((label) => label.tip !== "").map((label) => `> ${label.tip}\n`).join("");
  const tags = labels.map((label) => `[${label.label}] `).join("");
  const body = annotation.body.trim() === "" ? "" : `${quoteLines(annotation.body)}\n`;
  switch (annotation.type) {
    case "deletion":
      return `${tags}Remove this\n\`\`\`\n${annotation.originalText}\n\`\`\`\n> I don't want this in the ${subject}.\n${tips}${body}`;
    case "comment":
      return `${tags}Feedback on: "${annotation.originalText}"\n${tips}${body}`;
    case "global":
      return `${tags}General feedback about the ${subject}\n${tips}${body}`;
  }
}

function replyBlock(annotation: PlanAnnotation): string {
  if (annotation.replies.length === 0) return "";
  const lines = annotation.replies.map((reply) => `- **Reply (${reply.author.name}):** ${reply.body.trim().replace(/\r?\n/g, "\n  ")}\n`);
  return `**Replies:**\n${lines.join("")}`;
}

function labelSummary(annotations: readonly PlanAnnotation[], quickLabels: readonly QuickLabel[]): string {
  const counts = new Map<string, number>();
  for (const annotation of annotations) {
    for (const label of labelsOf(annotation, quickLabels)) counts.set(label.label, (counts.get(label.label) ?? 0) + 1);
  }
  if (counts.size === 0) return "";
  const rows = [...counts.entries()].map(([label, count]) => `- **${label}**: ${count}\n`).join("");
  return `## Label Summary\n\n${rows}\n`;
}

export function exportPlanFeedback(
  blocks: readonly PlanBlock[],
  annotations: readonly PlanAnnotation[],
  quickLabels: readonly QuickLabel[] = DEFAULT_QUICK_LABELS,
  title = "Plan Feedback",
  subject = "plan",
): string {
  if (annotations.length === 0) return NO_CHANGES;
  const sorted = sortInDocumentOrder(annotations, blocks);
  let output = `# ${title}\n\n`;
  output += `I've reviewed this ${subject} and have ${sorted.length} piece${sorted.length > 1 ? "s" : ""} of feedback:\n\n`;
  sorted.forEach((annotation, index) => {
    output += `## ${index + 1}. `;
    if (annotation.inDiff) output += "[In diff content] ";
    else {
      const label = lineLabel(blocks, annotation);
      if (label !== null) output += `(${label}) `;
    }
    output += entry(annotation, labelsOf(annotation, quickLabels), subject);
    output += replyBlock(annotation);
    output += "\n";
  });
  output += "---\n";
  const summary = labelSummary(sorted, quickLabels);
  if (summary !== "") output += `\n${summary}`;
  return output;
}

/** Plannotator's `planDenyFeedback`: what a denied plan tells the agent. */
export function planDenyFeedback(feedback: string, toolName = "ExitPlanMode"): string {
  return (
    `YOUR PLAN WAS NOT APPROVED.\n\nYou MUST revise the plan to address ALL of the feedback below before calling ${toolName} again.\n\n` +
    `Rules:\n- Do not resubmit the same plan unchanged.\n- Do NOT change the plan title (first # heading) unless the user explicitly asks you to.\n\n` +
    `${feedback === "" || feedback === NO_CHANGES ? "Plan changes requested" : feedback}`
  );
}
