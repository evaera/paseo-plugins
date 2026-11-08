/**
 * A shell command cut into tinted pieces for a `[[run: …]]` pill: the program, its flags, quoted strings,
 * variable assignments before a program, and the operators between commands. Pure and approximate: it
 * colours, it never decides what runs, and joining the pieces gives back the command exactly.
 */

export type TintKind = "program" | "flag" | "string" | "operator" | "assignment" | "plain" | "space";

export interface TintPiece {
  kind: TintKind;
  text: string;
}

const PIECE = /\s+|"(?:[^"\\]|\\.)*"?|'[^']*'?|&&|\|\||[|;&<>]|[^\s"'|;&<>]+/g;

export function tintCommand(command: string): TintPiece[] {
  const pieces: TintPiece[] = [];
  let expectProgram = true;
  for (const match of command.matchAll(PIECE)) {
    const text = match[0];
    let kind: TintKind;
    if (/^\s/.test(text)) kind = "space";
    else if (/^(&&|\|\||[|;&<>])$/.test(text)) kind = "operator";
    else if (/^["']/.test(text)) kind = "string";
    else if (expectProgram && /^[A-Za-z_]\w*=/.test(text)) kind = "assignment";
    else if (expectProgram) kind = "program";
    else if (/^-/.test(text)) kind = "flag";
    else kind = "plain";
    if (kind === "operator") expectProgram = !/^[<>]$/.test(text);
    else if (kind !== "space" && kind !== "assignment") expectProgram = false;
    pieces.push({ kind, text });
  }
  return pieces;
}
