/**
 * A path's language: the editor's id (for highlighting), the language server
 * family that serves it, and the LSP `languageId` for `didOpen`.
 */
import { extname } from "node:path";

import type { LanguageId } from "../shared/settings";

interface LanguageInfo {
  /** What `debrief.file.contents` reports; the client picks a highlighter from it. */
  editor: string;
  server: LanguageId | null;
  lspId: string;
}

const BY_EXTENSION: Record<string, LanguageInfo> = {
  ".ts": { editor: "typescript", server: "typescript", lspId: "typescript" },
  ".mts": { editor: "typescript", server: "typescript", lspId: "typescript" },
  ".cts": { editor: "typescript", server: "typescript", lspId: "typescript" },
  ".tsx": { editor: "tsx", server: "typescript", lspId: "typescriptreact" },
  ".js": { editor: "javascript", server: "typescript", lspId: "javascript" },
  ".mjs": { editor: "javascript", server: "typescript", lspId: "javascript" },
  ".cjs": { editor: "javascript", server: "typescript", lspId: "javascript" },
  ".jsx": { editor: "jsx", server: "typescript", lspId: "javascriptreact" },
  ".go": { editor: "go", server: "go", lspId: "go" },
  ".py": { editor: "python", server: "python", lspId: "python" },
  ".pyi": { editor: "python", server: "python", lspId: "python" },
  ".rs": { editor: "rust", server: "rust", lspId: "rust" },
  ".c": { editor: "cpp", server: "cpp", lspId: "c" },
  ".h": { editor: "cpp", server: "cpp", lspId: "c" },
  ".cc": { editor: "cpp", server: "cpp", lspId: "cpp" },
  ".cpp": { editor: "cpp", server: "cpp", lspId: "cpp" },
  ".cxx": { editor: "cpp", server: "cpp", lspId: "cpp" },
  ".hh": { editor: "cpp", server: "cpp", lspId: "cpp" },
  ".hpp": { editor: "cpp", server: "cpp", lspId: "cpp" },
  ".hxx": { editor: "cpp", server: "cpp", lspId: "cpp" },
  ".m": { editor: "cpp", server: "cpp", lspId: "objective-c" },
  ".mm": { editor: "cpp", server: "cpp", lspId: "objective-cpp" },
  ".lua": { editor: "lua", server: "lua", lspId: "lua" },
  ".json": { editor: "json", server: null, lspId: "json" },
  ".jsonc": { editor: "json", server: null, lspId: "jsonc" },
  ".css": { editor: "css", server: null, lspId: "css" },
  ".scss": { editor: "css", server: null, lspId: "scss" },
  ".html": { editor: "html", server: null, lspId: "html" },
  ".htm": { editor: "html", server: null, lspId: "html" },
  ".md": { editor: "markdown", server: null, lspId: "markdown" },
  ".markdown": { editor: "markdown", server: null, lspId: "markdown" },
};

const PLAIN: LanguageInfo = { editor: "plaintext", server: null, lspId: "plaintext" };

export function languageOf(path: string): LanguageInfo {
  return BY_EXTENSION[extname(path).toLowerCase()] ?? PLAIN;
}
