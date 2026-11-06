# Debrief

Review an agent's changes inside [Paseo](https://paseo.sh). Debrief opens as a workspace tab (from
the "+" menu, next to Diff) and replaces [Crit](https://crit.md): a from-vs-to diff in a real
editor, inline comments the agent answers live, stories, and plan review.

## Install

Debrief needs Paseo **0.14.0** or newer, and the daemon needs `"pluginsEnabled": true` in
`~/.paseo/config.json`. For agents to reply, Paseo's agent tools must also be on
(`daemon.mcp.injectIntoAgents`); the panel shows a banner when they are not.

```bash
paseo plugin add git:evaera/paseo-plugins:debrief
```

Add `--ref <tag or commit>` to pin a version; tags are `debrief/v<version>`. Install it on every
host whose workspaces you review, with `--host` or on that machine: Debrief's daemon half runs where
the code is. Installing runs `npm ci` for Debrief's editor libraries, so the daemon needs npm on its
path.

To work on it, clone the repository, run `npm install` in this folder, and install the folder
itself with `paseo plugin install "$PWD"`.

## What it does

- **Compare.** The header reads "FROM vs TO": main, the branch's remote branch, HEAD, staged, the
  working tree, or any ref. Presets cover main vs working tree, upstream vs working tree, and main
  vs upstream.
- **Diff.** One continuous, virtualized scroll across every file, unified or split, with unchanged
  lines folded around each hunk and expandable. The editor uses Paseo's code font and syntax
  colours, and the working-tree side is editable.
- **Comments.** Click or drag in the line numbers to comment on lines, or comment on a file or the
  whole review. Every comment, edit, resolve and approval reaches the agent at once as a Paseo
  agent message; the agent replies in the thread with its tools. The "N comments" menu, and the
  Debrief button in the workspace header, list every thread and jump to it.
- **Approve per file.** Each file has an Approve checkbox, like GitHub's "Viewed". It is stored per
  compare, so a file that changes after you approved it unticks itself and is flagged "Changed
  since approved". A ring in the header shows how many files are approved.
- **Stories.** An agent can write a story of the change: chapters in reading order, the files in
  each chapter in the order it chooses, and narration placed at lines in the code.
- **Plan review.** Claude's plan approvals (`ExitPlanMode`) and plans submitted with
  `debrief_submit_plan` open for annotation: comments, deletions and quick labels, versions with a
  diff between them, then Approve or Send feedback.

## Language intelligence

Go-to-definition (F12 or Cmd/Ctrl-click), references (Shift+F12), hover and completion come from
real language servers, the same ones an editor like Neovim uses. They run on the **daemon's host**,
next to the code, so each host needs its own.

For each language Debrief uses the first server it finds:

1. the command set for that language in Debrief's settings (per-language overrides);
2. Mason's install folder, `~/.local/share/nvim/mason/bin`;
3. your login shell's `PATH` (resolved once with `$SHELL -lc`, since the daemon's own `PATH` is
   minimal);
4. the project's `node_modules/.bin`, for TypeScript.

| Language | Servers looked for, in order |
| --- | --- |
| TypeScript, JavaScript | `vtsls`, `typescript-language-server` |
| Go | `gopls` |
| Python | `basedpyright-langserver`, `pyright-langserver` |
| Rust | `rust-analyzer` |
| C, C++ | `clangd` |
| Lua | `lua-language-server` |

A server starts the first time a file needs it, one per workspace and language, rooted at the
workspace folder. It stops after five minutes without use or when the workspace is archived. When
none is found the editor says so in one line ("No language server for Go; set one in Settings")
and everything else keeps working. Navigation works on the new side; definitions outside the diff
open in Debrief's own file view, with Back.

## For agents

Debrief adds tools to every agent in a workspace: `debrief_reply`, `debrief_list_comments`,
`debrief_comment`, `debrief_story_prep`, `debrief_write_story`, `debrief_annotate`,
`debrief_submit_plan` and `debrief_plan_reply`. Agents started before Debrief was installed get
them the next time their session reopens.

## Data

Reviews, stories and plans live under `$PASEO_HOME/plugin-data/debrief/`, written only by Debrief's
daemon half. Reviews of workspaces archived more than 30 days ago are pruned.

The plugin rules, and Debrief's own notes, are in the repository's [`AGENTS.md`](../AGENTS.md).
