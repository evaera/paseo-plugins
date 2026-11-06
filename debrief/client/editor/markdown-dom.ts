/**
 * Markdown as DOM for the editor's widgets, from the small reader in
 * `markdown-lite.ts`. Text is only ever set through `textContent`, so a body
 * cannot inject markup.
 */
import { type Inline, parseMarkdownLite } from "../markdown-lite";
import { domDocument, type El, h } from "./dom";

function inline(parts: readonly Inline[]): El[] {
  const doc = domDocument();
  return parts.map((part) => {
    const tag = part.kind === "code" ? "code" : part.kind === "strong" ? "strong" : part.kind === "em" ? "em" : "span";
    const el = doc.createElement(tag);
    el.textContent = part.text;
    return el;
  });
}

function withChildren(tag: string, children: readonly El[]): El {
  const el = domDocument().createElement(tag);
  children.forEach((child) => el.appendChild(child));
  return el;
}

export function markdownDom(markdown: string, className = ""): El {
  const root = h("div", { className: `cm-debrief-md ${className}`.trim() });
  parseMarkdownLite(markdown).forEach((block) => {
    if (block.kind === "paragraph") root.appendChild(withChildren("p", inline(block.inline)));
    else if (block.kind === "heading") root.appendChild(withChildren("h4", inline(block.inline)));
    else if (block.kind === "code") {
      const pre = domDocument().createElement("pre");
      pre.textContent = block.text;
      root.appendChild(pre);
    } else {
      root.appendChild(
        withChildren(
          block.ordered ? "ol" : "ul",
          block.items.map((item) => withChildren("li", inline(item))),
        ),
      );
    }
  });
  return root;
}
