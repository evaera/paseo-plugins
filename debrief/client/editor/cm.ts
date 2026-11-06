/**
 * CodeMirror, loaded on first use. The daemon bundles these packages (they are
 * real `dependencies`), but nothing here is evaluated until `loadCodeMirror` is
 * called, and only `mountEditor` calls it, after checking `Platform.OS`. This is
 * the `require` pattern Paseo's markdown-panel example uses, so native never
 * evaluates the editor.
 */
import type { Extension } from "@codemirror/state";

function load() {
  return {
    state: require("@codemirror/state") as typeof import("@codemirror/state"),
    view: require("@codemirror/view") as typeof import("@codemirror/view"),
    commands: require("@codemirror/commands") as typeof import("@codemirror/commands"),
    language: require("@codemirror/language") as typeof import("@codemirror/language"),
    autocomplete: require("@codemirror/autocomplete") as typeof import("@codemirror/autocomplete"),
    search: require("@codemirror/search") as typeof import("@codemirror/search"),
    merge: require("@codemirror/merge") as typeof import("@codemirror/merge"),
    highlight: require("@lezer/highlight") as typeof import("@lezer/highlight"),
    syntax: require("./syntax") as typeof import("./syntax"),
  };
}

export type CM = ReturnType<typeof load>;

let loaded: CM | null = null;

export function loadCodeMirror(): CM {
  loaded ??= load();
  return loaded;
}

/** The language support for the server's `language` id; none for anything unknown. */
export function languageExtension(id: string): Extension[] {
  switch (id.toLowerCase()) {
    case "typescript":
    case "ts": {
      const { javascript } = require("@codemirror/lang-javascript") as typeof import("@codemirror/lang-javascript");
      return [javascript({ typescript: true })];
    }
    case "typescriptreact":
    case "tsx": {
      const { javascript } = require("@codemirror/lang-javascript") as typeof import("@codemirror/lang-javascript");
      return [javascript({ typescript: true, jsx: true })];
    }
    case "javascript":
    case "js": {
      const { javascript } = require("@codemirror/lang-javascript") as typeof import("@codemirror/lang-javascript");
      return [javascript()];
    }
    case "javascriptreact":
    case "jsx": {
      const { javascript } = require("@codemirror/lang-javascript") as typeof import("@codemirror/lang-javascript");
      return [javascript({ jsx: true })];
    }
    case "python":
    case "py": {
      const { python } = require("@codemirror/lang-python") as typeof import("@codemirror/lang-python");
      return [python()];
    }
    case "go": {
      const { go } = require("@codemirror/lang-go") as typeof import("@codemirror/lang-go");
      return [go()];
    }
    case "rust":
    case "rs": {
      const { rust } = require("@codemirror/lang-rust") as typeof import("@codemirror/lang-rust");
      return [rust()];
    }
    case "c":
    case "cpp":
    case "c++":
    case "objective-c":
    case "objective-cpp": {
      const { cpp } = require("@codemirror/lang-cpp") as typeof import("@codemirror/lang-cpp");
      return [cpp()];
    }
    case "markdown":
    case "md": {
      const { markdown } = require("@codemirror/lang-markdown") as typeof import("@codemirror/lang-markdown");
      return [markdown()];
    }
    case "json":
    case "jsonc": {
      const { json } = require("@codemirror/lang-json") as typeof import("@codemirror/lang-json");
      return [json()];
    }
    case "css":
    case "scss":
    case "less": {
      const { css } = require("@codemirror/lang-css") as typeof import("@codemirror/lang-css");
      return [css()];
    }
    case "html": {
      const { html } = require("@codemirror/lang-html") as typeof import("@codemirror/lang-html");
      return [html()];
    }
    default:
      return [];
  }
}
