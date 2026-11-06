/**
 * Paseo's own syntax colours, so the editor highlights as the app's diff does.
 *
 * Only the colour data comes from `@getpaseo/highlight`. Its
 * `createCodeMirrorHighlightStyle` would build the style from the ESM copies of
 * `@codemirror/language` and `@lezer/highlight`, while `cm.ts` `require`s the
 * CommonJS copies, and the bundle keeps both: tags from one copy never match a
 * style from the other, and nothing gets coloured. So the style is built here
 * from the modules `cm.ts` loaded, with the tag-to-role table copied from
 * `@getpaseo/highlight`'s `syntax-roles.ts`.
 *
 * Only `cm.ts` requires this module, after the platform check, so native never
 * evaluates it.
 */
import { isSyntaxThemeId, resolveSyntaxColors, type SyntaxColors } from "@getpaseo/highlight";
import type { HighlightStyle } from "@codemirror/language";

type Language = typeof import("@codemirror/language");
type Highlight = typeof import("@lezer/highlight");
type Role = keyof SyntaxColors;

function roleTags({ tags }: Highlight): ReadonlyArray<{ tag: import("@lezer/highlight").Tag; role: Role }> {
  return [
    { tag: tags.keyword, role: "keyword" },
    { tag: tags.controlKeyword, role: "keyword" },
    { tag: tags.operatorKeyword, role: "keyword" },
    { tag: tags.definitionKeyword, role: "keyword" },
    { tag: tags.moduleKeyword, role: "keyword" },
    { tag: tags.comment, role: "comment" },
    { tag: tags.lineComment, role: "comment" },
    { tag: tags.blockComment, role: "comment" },
    { tag: tags.docComment, role: "comment" },
    { tag: tags.string, role: "string" },
    { tag: tags.special(tags.string), role: "string" },
    { tag: tags.number, role: "number" },
    { tag: tags.integer, role: "number" },
    { tag: tags.float, role: "number" },
    { tag: tags.bool, role: "literal" },
    { tag: tags.null, role: "literal" },
    { tag: tags.function(tags.variableName), role: "function" },
    { tag: tags.function(tags.propertyName), role: "function" },
    { tag: tags.definition(tags.variableName), role: "definition" },
    { tag: tags.definition(tags.propertyName), role: "definition" },
    { tag: tags.definition(tags.function(tags.variableName)), role: "definition" },
    { tag: tags.className, role: "class" },
    { tag: tags.definition(tags.className), role: "class" },
    { tag: tags.typeName, role: "type" },
    { tag: tags.tagName, role: "tag" },
    { tag: tags.attributeName, role: "attribute" },
    { tag: tags.attributeValue, role: "string" },
    { tag: tags.propertyName, role: "property" },
    { tag: tags.variableName, role: "variable" },
    { tag: tags.local(tags.variableName), role: "variable" },
    { tag: tags.special(tags.variableName), role: "variable" },
    { tag: tags.operator, role: "operator" },
    { tag: tags.punctuation, role: "punctuation" },
    { tag: tags.bracket, role: "punctuation" },
    { tag: tags.separator, role: "punctuation" },
    { tag: tags.regexp, role: "regexp" },
    { tag: tags.escape, role: "escape" },
    { tag: tags.meta, role: "meta" },
    { tag: tags.heading, role: "heading" },
    { tag: tags.link, role: "link" },
    { tag: tags.url, role: "link" },
  ];
}

export function paseoHighlightStyle(
  language: Language,
  highlight: Highlight,
  themeId: string,
  dark: boolean,
): HighlightStyle {
  const colors = resolveSyntaxColors(isSyntaxThemeId(themeId) ? themeId : "one", dark ? "dark" : "light");
  return language.HighlightStyle.define(roleTags(highlight).map(({ tag, role }) => ({ tag, color: colors[role] })));
}
