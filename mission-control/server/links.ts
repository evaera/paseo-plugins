/**
 * The links in a line of text, for a card. Shared by the backlog and a
 * crewmate's status line, so a link written in both reads the same and is
 * shown once.
 *
 * A link stops at whitespace, parentheses, angle and square brackets and a
 * backtick, so `[https://x](https://x)` and `` `https://x` `` are one clean
 * link each; punctuation that ends the sentence rather than the link
 * (`…/pull/41, and`) is dropped.
 */
export const LINK = /https?:\/\/[^\s()<>[\]`]+/;

export function findLinks(text: string): string[] {
  const found = (text.match(new RegExp(LINK.source, "g")) ?? []).map((link) => link.replace(/[.,;:!?'"*]+$/, ""));
  return [...new Set(found.filter((link) => /^https?:\/\/[^/]/.test(link)))];
}
