# AGENTS.md

A Paseo plugin that adds a **Mission Control** screen: a conversation with one "Mission Control" agent
beside a board of the "crew" of agents it runs, each in its own git worktree. A Paseo-native port of
[kunchenguid/firstmate](https://github.com/kunchenguid/firstmate) — the agent distro — by way of
[ABorakati/paseo-firstmate](https://github.com/ABorakati/paseo-firstmate), which was a dashboard over
that distro's bash scripts and does not install on Paseo 0.9.

The repo root `AGENTS.md` covers what every plugin here shares: the per-folder npm layout, the
typecheck/reload loop, the client/server bundle split, and the constraints nothing catches at
compile time. This file covers only what is specific to `mission-control`.

## Orientation

| File                          | What it owns                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `index.server.ts`             | Wiring — the RPCs, the display settings document, the steer relay hook.                    |
| `index.client.tsx`            | Wiring — the screen, sidebar item, two panels, settings screen, ⌘K items, `/mc` `/mc-status` `/mc-catch-up`. |
| `shared/fleet.ts`             | Every RPC contract, the card/fleet shapes, the daemon config shape, and `CREW_LABELS`.     |
| `shared/settings.ts`          | The host settings document: the card order, folded columns, the chat's width, the poll interval. |
| `templates/`                  | **Every file the plugin writes into the home**, as Markdown laid out as it lands there, and the parts that go inside them. Mission Control's behaviour is `templates/prompts/charter.md`. |
| `server/templates.ts`         | Finds `templates/` — through `paseo plugin ls`, since the compiled plugin cannot say where it lives — and reads it. |
| `server/charter.ts`           | Renders `AGENTS.md`: the charter's placeholders filled, under its heading note.            |
| `server/charter-file.ts`      | `prompts/charter.md`, the user's copy it is rendered from: follows the plugin until edited. |
| `server/home.ts`              | The home directory: writes the charter and records, reads the backlog and project registry. |
| `server/backlog.ts`           | `state/backlog.md` → `BacklogItem[]`, `(actions: …)` included. Lenient, because an agent writes the file. |
| `server/suggestions.ts`       | `state/suggestions.md` → `Suggestion[]`, the board's next-step buttons, taking one out, and the dismissed list that hides it after. Lenient, likewise. |
| `server/crew-report.ts`       | A crewmate's closing status line (`done: PR …`) → state and text.                          |
| `server/fleet.ts`             | The board: Mission Control, crew by label, backlog, status lines → cards in columns.            |
| `server/coordinator.ts` | Launching, adopting and releasing Mission Control; carrying the user's words to it.      |
| `server/crew.ts`              | Steer, interrupt, end, relaunch one crewmate; the relay that tells Mission Control about a steer. |
| `server/crew-seen.ts`         | Clears a crewmate's "finished" flag once a later Mission Control turn has completed.            |
| `server/watches.ts`           | The watch runner: the minute timer, runs, the queue, `<mission-control-watch>` notes, `watches.json`. |
| `server/watch-service.ts`     | The runner wired to Paseo: the kept Paseo handle, delivery to Mission Control, the on/off switch. |
| `server/watch-files.ts`       | `watches/`: which files are watches, their `schedule:` line, seeding the built-ins.        |
| `server/watch-schedule.ts`    | A crontab line → `Schedule`, and whether a local minute matches it. Pure.                  |
| `server/watch-run.ts`         | One script run: its own process group, a timeout, stdout capped, stderr's tail.           |
| `server/send.ts`              | Sending to an agent without interrupting its turn where the provider allows (`"steer"`).   |
| `shared/attachments.ts`       | What the user can attach: the message's shape, image-or-file by Paseo's rules, the size cap. |
| `server/uploads.ts`           | An attached file written to `$PASEO_HOME/uploads/`, described as Paseo's `uploaded_file`.     |
| `server/cli.ts`               | `paseo stop` and `paseo project rename`, for what the SDK does not have.                   |
| `server/home-name.ts`         | Names the home's project and workspace "Mission Control" instead of the folder's "home".         |
| `server/daemon-session.ts`    | One raw session request over the plugin's channel: clearing an agent's attention.          |
| `server/config.ts`            | `$PASEO_HOME/plugin-data/mission-control/config.json`, read on every call; the default home.     |
| `server/data-dir.ts`          | `$PASEO_HOME/plugin-data/mission-control/`, where the plugin keeps its own files.     |
| `server/serialize.ts`         | Runs the config update and each home file's save one at a time, per file.                  |
| `server/host-types.ts`        | Paseo types projected out of `@getpaseo/plugin`; see the root AGENTS.md.                    |
| `client/fleet.tsx`            | The screen: header, banners, chat/board split, compact tabs, the shared fleet query.       |
| `client/screen.ts`            | The screen's id, and the count of working and idle crewmates on its sidebar row. Pure.     |
| `client/sidebar.tsx`          | The sidebar item: the Mission Control row and its badge.                                         |
| `client/chat.tsx`             | Mission Control's conversation, folded to the words, and the composer.                      |
| `client/unread.ts`, `app-focus.ts` | Which Mission Control messages are new since the last one seen (`chatSeen` in the display settings), and whether the user is looking: app active and, on the web, its window focused. |
| `client/draft.ts`, `attachments.ts` | The unsent message and what is attached to it, kept on `globalThis` across reloads.  |
| `shared/files.ts`, `server/files.ts` | The home as files: list, read, write — confined to the home, saved against the version opened. |
| `client/files.tsx`            | The Files view: the home's folders, a text editor, a Markdown preview.                     |
| `client/open-file.ts`         | The file open in the Files view, and what a save changes about it. Pure.                   |
| `client/permission-card.tsx`  | What an agent is waiting on — a question, a permission, a plan — answered in the chat or in a card's view. |
| `client/questions.ts`         | The question form's rules, ported from Paseo's own card. Pure.                             |
| `client/keyboard.ts`          | How far the on-screen keyboard covers a view, measured in window coordinates.              |
| `client/keys.ts`              | Enter sends, Shift+Enter is a new line — web and wide layouts only, as in Paseo. Pure.     |
| `client/transcript-rows.ts`   | Timeline entries → chat rows. Pure.                                                        |
| `client/board.tsx`, `card.tsx`| The columns; a card's summary on the board (`CrewCard`) and the whole card (`CardSheet`).  |
| `client/board-motion.ts`, `column-frame.tsx`, `flash.tsx` | What moved since the board was last drawn, a column that grows open and shrinks away, and the wash and entrance the board and the chat both use. |
| `client/sortable.tsx`         | A column's cards rearranged by a drag handle; the order is saved as `cardOrder` in the display settings. |
| `client/order.ts`             | That order: rank keys (a card's task where it has one), sorting, where a drop lands, what Mission Control is given. Pure. |
| `server/rename.ts`            | A task renamed from its card: the title on its backlog line rewritten in place, links and fields kept, compare-and-swap against Mission Control. |
| `server/board-order.ts`       | `state/board-order.md`, that order written into the home on every drag, which charter §2 makes the user's priority. |
| `client/card-commands.ts`     | What an open card offers by column: the choices the column asks for (Start, Keep going, Waiting on…, Mark done), the worker's tools, and End or Drop. Pure. |
| `client/context-menu.tsx`     | A card's right-click (long press on touch) menu, drawn over the board: `contextMenu` in `card-commands.ts` lists what the open card offers. |
| `client/board-tasks.ts`       | The board's tasks for a card that names another: "Blocked by" and its picker, provided by the screen and panels. |
| `client/avatar.ts`, `avatar-view.tsx` | Each worker's face: a 16×16 pixel robot or alien picked from parts by hashing its agent id, as inline SVG, posed by its state in a short loop, with a dot in the corner for an error or a request. |
| `client/worker-state.ts`      | Where a worker stands as one icon, word and tone, for a card's state line and the worker's header. Pure. |
| `client/card-details.tsx`     | An open card's host, branch and folder, as Paseo's hover card draws them, and when it was added. |
| `client/local-host.ts`        | The board's own host label, provided by the screen and panels for a local worker's host line. |
| `client/card-answer.ts`       | A card's `(actions: …)` buttons and a held card's Answer box: what they send, the kept drafts. Pure. |
| `client/suggestions.tsx`      | Mission Control's suggestions as buttons: a card on the wide board, a tab on a phone.       |
| `client/suggestion-removals.ts` | Which suggestions have a removal on its way, by label and prompt. Pure.                  |
| `client/suggestion-fold.ts`   | Whether a folded suggestion card cuts its text, measured against an invisible twin. Pure. |
| `client/watches.tsx`          | The Watches card: each watch's schedule, last run and output, and its on/off switch.       |
| `client/coordinator-send.ts` | Sending to Mission Control — Send, Status, Catch up, a suggestion — one message at a time.    |
| `client/card-view.tsx`        | A card's own view, in the board's place: the whole card and its notes, and a worker's live transcript with a box to talk to it. |
| `client/task-notes.tsx`, `server/notes.ts` | The user's notes on a task, `tasks/<id>/user-notes.md`, which Mission Control reads. |
| `client/chat-about.ts`        | The card Mission Control's chat is pointed at, drawn as a pill on the composer, and the request for its cursor. |
| `client/activity-rows.ts`     | Timeline entries → a card view's transcript rows, machinery kept: reasoning, tool detail, the latest plan. Pure. |
| `client/coordinator-controls.tsx` | The context meter, Compact and Restart (with its confirmation), at the end of the chat's buttons. |
| `client/context-meter.tsx`    | How full Mission Control's context is: Paseo's ring, built from views; the numbers in a tooltip. |
| `client/use-follow-end.ts`, `follow-end.ts` | A streaming transcript that follows its end, brings a new request into view, jumps back; the end check itself. |
| `client/launch.tsx`           | What shows before there is a Mission Control agent: launch one, or adopt a running agent.             |
| `client/panels.tsx`           | The workspace and agent panels: the crewmate's card beside its own tab.                    |
| `client/settings-screen.tsx`  | Settings › Plugins › Mission Control.                                                            |
| `client/markdown.tsx`         | A trimmed copy of `github-board`'s renderer, for Mission Control's replies.                 |
| `client/markdown-parse.ts`    | The renderer's blocks, and the inline text in them — what `file-links.ts` walks. Pure.     |
| `client/file-links.ts`        | A reply's inline tokens, and the home files it names that the daemon (`mission-control.files.find`) says exist. Pure. |
| `client/type-scale.ts`        | Every font size, by role, at Paseo's default sizes; the one file to change when the theme carries Paseo's font setting. |
| `client/option-picker.tsx`    | A copy of `herald`'s searchable picker, for the model lists.                               |
| `client/web.ts`, `resize-handle.tsx` | The chat/board split's drag (a copy of `github-board`'s); the chat's file picker, paste and drop. |

## The plugin never dispatches a crewmate

Mission Control does, with **Paseo's own MCP tools** — `create_workspace` for the worktree,
`create_agent` for the crewmate, `send_agent_prompt` to steer, `archive_agent` to clean up. The plugin
gives it a home and a charter, starts it, carries the user's words to it, and draws the result.
That was ABorakati's rule too ("the plugin deliberately does NOT dispatch crewmates itself"), and it
keeps authority in one place: Mission Control owns intake, the brief and the backlog.

What that costs:

- **Paseo's agent tools must be on** — `daemon.mcp.injectIntoAgents`, **off by default** in Paseo. The
  board reads it through `paseo.config.get()` and offers a button that patches it on. A session gets
  its tool set when it starts or resumes, so a Mission Control agent launched before the switch needs a reload.
- **The charter is a contract with a model, not with code.** A weaker model can misuse the tools — a
  Haiku Mission Control on the test daemon tried to run `mcp__paseo__list_agents` as a shell command — which
  is why the charter names the tools and says outright that they are never shell commands.

## Supervision is Paseo's, not ours

FirstMate's "zero-token supervision" was a bash watcher sleeping on status files. Paseo already has it:
when an agent creates or prompts another through the MCP tools with `notifyOnFinish` (on by default
for agent-scoped calls), the daemon sends the creator a `<paseo-system>` note when the child finishes,
errors, is closed or asks for a permission — with the child's last message, delivered with the same
`activeTurnBehavior: "steer"` described under *Sending without interrupting*. The charter tells Mission
Control to keep it on and to read the crewmate's **status line**, the last line of that message.

Two gaps, and what fills them:

- **A turn the user started from the board** was prompted by nobody Paseo knows to notify.
  `registerSteerRelay` remembers each steer (`UserSteers`, in memory, an hour at most) and sends
  Mission Control a `<mission-control-board>` note with what was said and answered — on the first
  `agent.turn_ended` whose timeline **contains** the steer as a user message, and never on a cancelled
  one. The first turn to end is not always the answer: the one that was running may end first, and a
  provider that cannot steer cancels it. A steer whose send failed is taken back, so it is never
  relayed as said.
- **Nothing wakes a Mission Control agent whose crew went quiet.** Its **wake** does: one Paseo heartbeat
  named `Mission Control wake`, on the schedule in `prompts/wake.md`, which charter §3 has Mission Control set
  with `create_heartbeat` every time it takes over. Paseo replaces a heartbeat with the same name and
  target in place (`createOrReplace`), so that is safe to repeat and is how a changed schedule lands; and
  Paseo completes an archived agent's schedules, so a restart never leaves the old one firing. A
  *released* Mission Control keeps its heartbeat, since it is still a live agent. The plugin does not make
  the heartbeat itself: `create_heartbeat` targets its caller, the SDK has no schedules, and the CLI's
  `schedule create` makes only new-agent schedules.

The notification watches once per prompt. A crewmate prompted by hand in its own tab is not watched
by anyone; the wake is what catches it.

**Wakes and watches split by cost.** A watch is a script on the plugin's own clock that costs nothing
until it prints; a wake is a turn every time. So a check a script can make is a watch, and `prompts/wake.md`
is for what needs judgment. Charter §7 fixes what every wake does before the user's steps — the crew, and
pull requests only when `pr-watch` is switched off or failing, which Mission Control reads from
`config.json` and `watches.json` — so the two never both do the same work. The wake's checks live in the
charter rather than in `prompts/wake.md`, so they follow the plugin; the file is written once and is the
user's.

## Sending without interrupting

`PaseoAgentHandle.send` **interrupts a running turn by default.** For Mission Control that is wrong — it
may be halfway through a dispatch — so `server/send.ts` sets `activeTurnBehavior: "steer"`, which the
SDK declares since 0.11 (`PaseoAgentSendOptions` is the daemon client's `SendMessageOptions`); 0.9's
handle passed it through undeclared. Everything the plugin sends goes through it.

"Steer" is only as gentle as the provider. The message joins the running turn where the provider
can take one mid-turn; where it cannot, the daemon's `steerOrReplaceActiveTurn` **cancels** the turn
and starts a new one from the message. That is the same path Paseo's own finish notifications take,
so it is no worse than what Mission Control already lives with, but it is not a guarantee — and it is
why the steer relay above cannot assume the first `turn_ended` after a steer is the answer to it.

## The crew is found by label

The charter tells Mission Control to create every crewmate with the labels in `CREW_LABELS`
(`pmc.role=crew`, `pmc.task`, `pmc.kind`, `pmc.project`), and the board lists
`agents.list({ filter: { labels: { "pmc.role": "crew" } } })`. The charter imports the same
object, so the two cannot drift. A crewmate created without them is invisible to the board, which is
the first thing to check when the board is empty and Mission Control says otherwise.

A card joins a crewmate to its backlog line by the task label, or by the `(agent: …)` the line records;
whatever is left on either side is a card of its own.

**Mission Control itself is found only by `config.coordinatorAgentId`.** It is labelled
`pmc.role=mission-control` at launch, for `paseo ls --label`, but the label is not consulted: the SDK
cannot take a label off, so falling back to it would bring a released Mission Control straight back.

## Status lines are read on the daemon, cached by `updatedAt`

`ReportCache` fetches a crewmate's timeline tail only when its `updatedAt` has moved and it is not
mid-turn, so a poll every few seconds costs one agent listing and nothing else while the crew is
quiet. `closingText` joins the assistant messages at the very end — a streamed reply arrives in pieces
that split anywhere, even mid-word — and `parseCrewReport` looks for the status line only in the last
few lines, so "the build is done: …" earlier in a message is not a report.

Columns: a pending permission, an error or a running turn win (blocked, failed, working); once the
turn has ended, a task whose line has a `(hold: …)` is in Needs you unless the crewmate failed, since
what it waits on is the user; otherwise the status line decides; an ended turn with no status line is **Idle**. So is a
`done:` or `resolved:` one: **Done** is for work the backlog records as Done, and a crewmate that has
reported done is still alive and In flight until Mission Control lands it and moves the item. Its card
keeps the status line and the item's hold, so "Done: PR …" still reads on it from the Idle column.

The board draws only columns with a card in them, folded or not (`board.tsx`), as one row of fixed-width
columns in `BOARD_ORDER` that scrolls sideways, each column scrolling on its own; a phone stacks them.
Within a column the user's drag order comes first (`client/order.ts`), then the daemon's order.

**Changes move rather than jump.** `board-motion.ts` remembers, in module scope, which column every card was
in (by worker or task, never the line number) and which columns were drawn. A card in a new column, or new on
the board, slides up into place and lights a wash in that column's colour that fades (`Entrance`,
`FlashWash`); a column that was not drawn grows open from nothing, and one whose last card left is drawn empty
for a moment while it shrinks away (`ColumnFrame`), so the columns beside it slide instead of jumping. The
first look moves nothing, and a board drawn again after the user looked at a card shows what changed
meanwhile. A phone's stack fades a new column in and drops an emptied one. Width is a layout property, so the
columns run on the JavaScript driver; the rest is opacity and transform.

## Mission Control is told it lives in Paseo

Charter §0 says what Mission Control cannot work out for itself: that it runs inside Paseo, and that
Paseo — not its memory or its records — is where the user's projects, workspaces, agents,
providers and schedules are. It names both ways in: the MCP tools for acting on the crew, and the
`paseo` CLI for looking things up, with the exact commands. Without it a Mission Control agent asked "which
projects do you know?" answered from `state/projects.md` alone. So the registry now holds only each
project's delivery mode; which projects exist is `paseo project ls`.

The crew is listed with `paseo ls -g --label pmc.role=crew`, not the MCP `list_agents`:
that tool defaults to the last 48 hours and 50 agents, and a crewmate older than that would silently
drop out of Mission Control's view. Agents get `PASEO_CLI`, `PASEO_HOME` and their own
`PASEO_AGENT_ID` in their environment (seen on 0.9.1), which is what the charter points at.

## The templates

**No text the plugin writes into the home, or says to Mission Control, lives in code.** `templates/`
holds, in three places:

- **The home's files**, laid out as they land there — `AGENTS.md`, `icon.svg`, `prompts/user.md`,
  `prompts/wake.md` and the other records, `prompts/charter.md` with its note, `prompts/charter.new.md`, and
  `watches/` with the built-in watches and the folder's README.
- **`parts/`** — the sentences that fill `{{crewProviderRule}}`, `{{crewModeRule}}` and `{{crewFastRule}}` in the charter, one
  for a setting left open and one for a setting chosen.
- **`messages/`** — everything the plugin sends Mission Control: the opening, the note a restart adds after it,
  the Relaunch request, the note relaying a Steer (with the words for an answer that was too long or
  never came), and Status and Catch up, each with a second form for words typed after `/mc-status` or
  `/mc-catch-up`. A template cannot branch, so a message that reads differently when something is missing is
  two files. Status and Catch up are worded on the daemon — the app cannot read the plugin's files — so
  the buttons, ⌘K and the slash commands send `mission-control.coordinator.command` with the command's name and what
  followed it, and `commandText` picks the template. A watch message has no wrapper: it is `watch-output.md`
  and `watch-failed.md` blocks one after another, led by `watch-dropped.md`'s self-closing
  `<mission-control-watch-dropped count="N"/>` when a full queue dropped some.

`TEMPLATES` in `server/templates.ts` names every one, and `templates.test.ts` fails if the folder and that
list disagree, or if `package.json` stops shipping the folder (`files` names it; a top-level directory it
does not name is silently left out of the npm package).

HTML comments in a template are notes for whoever edits it. Where a template becomes a message or a part
of another file, `withoutNotes` leaves them out, so each part and message starts with a note saying where
it goes and what its placeholders are;
where a template is copied into the home as a file, its notes go with it and speak to the user.
Placeholders are `{{name}}` throughout, filled by `fill` in a single pass, which leaves any name it was
not given alone and never reads a filled-in value for placeholders — a crewmate's answer relayed through
a Steer can say `{{title}}` and arrives as written.

**Finding the folder is the one hard part.** Paseo compiles the server half into one CommonJS script and
evaluates it from memory: `import.meta` is an empty object in it (esbuild's CommonJS output), the process
runs in the daemon's directory, and nothing in the plugin API names the plugin's. The daemon knows, and
`paseo plugin ls --json` says — the folder of a directory install, and for an npm install the package
itself, inside the daemon's `node_modules` — so `templatesDirectory` asks it, once per process, through the
same CLI lookup as `paseo stop`. In the tests, where the code runs from its own files, `import.meta.url` is
real and the folder beside it is used. A failed lookup is not kept; the next call tries again.

Templates are read once per process, so a changed template reaches a home in use on the next reload, and
only as far as the home takes it: the charter is re-rendered, an untouched `prompts/charter.md` follows, and a
record the home already has is never rewritten.

Checked on a throwaway 0.9.1 daemon from the packed tarball, unpacked and installed as a directory: a home
got every file, `AGENTS.md` with no placeholder left; and on the real daemon a reload rendered the same
`AGENTS.md`, byte for byte, as the charter held in code before the move. An npm install of 0.1.0 lists its
`path` as the package folder in the daemon's `node_modules`, where `templates/` ships from 0.1.1.

## The home

`server/home.ts` writes `AGENTS.md` (the charter, **rendered from `prompts/charter.md` on every launch,
every settings save, every plugin start and every save of that file in the panel** — it names the crew's
model, and a charter change should reach a home in use without a relaunch; a running Mission Control still
has to be asked to re-read it) and creates `prompts/user.md`, `projects.md`, `backlog.md`,
`suggestions.md`, `suggestions-dismissed.md`, `learnings.md` and `wake.md` (its `{{timezone}}` the daemon's) only when missing, so a relaunch never loses a record. `prompts/user.md` is the
user's to edit and outranks the charter below its hard rules; that is where customisation that
should survive an upgrade goes.

**The default home is `$PASEO_HOME/plugin-data/mission-control/home`**, never under
`$PASEO_HOME/plugins/`, which is Paseo's install root and is deleted by `paseo plugin remove` (see the
root AGENTS.md). A home the config names elsewhere is used where it is.

There is **no `CLAUDE.md`**. Claude Code and Codex both read `AGENTS.md`, and a `CLAUDE.md` importing
it risks the charter twice in every turn. The opening asks the agent to read the file if it is not
already in its instructions, for a harness that reads neither.

**The opening is the plugin's.** A new Mission Control's first message, at launch and at restart, is
`templates/messages/opening.md`, with the restart note (`templates/messages/restart-note.md`) after it on
a restart. It is not a file in the home: anything a user would add to it belongs in `prompts/user.md`,
which the charter has Mission Control read first.

**Task folders are `tasks/<id>/`**, apart from `prompts/` and `state/`: a brief, a scout's report,
Mission Control's notes and the user's.

**The charter is the user's to edit, too.** `AGENTS.md` is rendered, so an edit there is lost at the
next reload; it is rendered from `prompts/charter.md`, which starts as `templates/prompts/charter.md` — the
plugin's charter under a note — and is the file to edit. The note lists the placeholders and records a fingerprint of the
plugin charter the copy was taken from, and that fingerprint is how `syncCharter` (`server/charter-file.ts`)
tells the two cases apart when a new plugin version changes the charter:

- **Untouched** — the copy still matches its fingerprint, so the user never edited it. It is replaced
  with the new charter: a home nobody customised keeps getting the plugin's improvements.
- **Edited** — the user's text is kept and rendered. If the plugin's charter has changed since the
  version the edit started from, the new one is written beside it as `prompts/charter.new.md` and the board
  shows a notice with **Compare**, which opens that file in the Files view (`mission-control.charter.compare`
  writes it first, so it is there even for a copy the sync has not seen yet), and **Done**, which moves the
  fingerprint on and removes the file (`mission-control.charter.acknowledge`). Done restores the note if the
  user deleted it; a copy without one counts as edited from nothing, so every plugin charter is news
  to it.

An emptied or deleted copy goes back to the plugin's charter. HTML comments are notes, left out of both
`AGENTS.md` and the comparison, so the fingerprint is of the words alone and a note of the user's own
does not count as an edit. The board reads the state on every poll (`readCharterState`, one small file);
only a sync or the two calls write. The charter's records table tells Mission Control that both files are
the user's.

The backlog format is the contract between an agent and `server/backlog.ts`. Changing one means
changing both, and the parser stays lenient: unknown groups are ignored, a line it cannot read is
skipped, and `(since …)` is accepted without the colon because that is how the charter spells it.

**A title never changes** (charter §2), except when the user renames a task by pressing its title in the
card's view: `mission-control.task.rename` rewrites the line's title in place — everything between the id's dash and
the first field, with any links that were among its words kept after it — and the charter has Mission Control
keep the user's title. In the demo dry run a Mission Control agent waiting for the word to land
two local branches wrote "…, ready in branch fm/…, awaiting user's approval to land" into both titles,
and the cards grew with them. The charter now says where status lives — the section, the crewmate's
status line, and `(hold: …)` for anything waiting on the user, which the card already shows as
"Your call".

## Watches run on the plugin's own clock

A watch is an executable script in the home's `watches/` folder that declares a crontab schedule in a
comment near its top (`server/watch-files.ts` says exactly which files count, and `templates/watches/README.md`
is the user's documentation, env vars included). `WatchRunner` (`server/watches.ts`) ticks on every
minute's boundary and runs whatever is due, enabled and valid. Paseo's own schedules are no use here: each
fire prompts an agent, and a watch's usual run should cost nothing. The schedule is read in the daemon's
local time, and a minute the daemon missed is not made up.

**Output goes to Mission Control only between turns.** Non-empty stdout is queued; a flush sends the whole
queue as one message, from `templates/messages/watch-*.md`, through `sendWithoutInterrupting`. It waits
while Mission Control is `running` or `initializing`, or absent, and asks Paseo afresh before every send —
never assumes, since a note sent into a newer turn can replace that turn where the provider cannot steer.
Mission Control's own `agent.turn_ended` tries the queue 1, 5 and 15 seconds later (`flushAfterTurn`: its
snapshot can still say running for a moment, and a crewmate's finish note may start a turn at once), and
every tick tries again. The queue holds `MAX_QUEUED` and counts what it drops, and one message holds at
most `MAX_MESSAGE_CHARS` (32,000), tags included: `fitWatchNote` keeps the newest blocks that fit and drops
the oldest whole, counting them in the same `<mission-control-watch-dropped>` tag and marking their watches
`dropped` on the card. The newest block always goes — two blocks at the 16,000 cap come to a little over
32,000 with their tags and marker, so only one is certain. **A run is one block**,
everything it printed, never a turn per line, and **a message carries nothing of the plugin's** — just
`<mission-control-watch name=… ran=…>` blocks one after another, oldest first, with the plugin's own facts
(a `failed=` block, a leading `<mission-control-watch-dropped count="N"/>`). How output is to be
read is the script's to say: charter §7 has Mission Control take a script's own instructions as the
user's, since the user approved the script, and what it marks as quoted from others as information
only, so a script that relays outside text has to mark it (`pr-watch` prints its own line saying the
text it takes from GitHub — titles, check names, reviews, comments — is other people's, and prints every
piece of it JSON-quoted, so a hostile title cannot pass for a line of the script's own).

Two defences keep a watch message honest, and both are needed:

- **What a script prints cannot write a tag.** `quoted` (`server/watches.ts`) turns the `<` of anything
  tag-shaped into `&lt;`, stdout and stderr alike — not only the watch's own tags but `<mission-control-board>`,
  `<paseo-system>` and whatever envelope comes next, since the charter tells Mission Control to trust
  those.
- **The chat folds only what the plugin sent.** A watch message goes out with a `messageId` starting
  `mission-control-watch-` (`WATCH_MESSAGE_ID_PREFIX`), which the daemon records as the timeline item's
  `clientMessageId` (`agent-prompt.ts` in Paseo). `watchSummary` (`client/transcript-rows.ts`) folds a
  message into one line naming the watches only when it carries that id and is watch-shaped; the user's
  words, even a pasted watch block, stay as they are. A timeline rebuilt without the id shows a watch
  message in full rather than hiding anything. `<paseo-system>` and `<mission-control-board>` notes are still
  recognised by their text alone.

**The timer has no Paseo handle of its own.** The plugin API passes `paseo` only to RPC handlers and hooks —
but it is one object per plugin process (`plugin-process.ts` in Paseo creates it once), so
`server/watch-service.ts` keeps the first it sees from `mission-control.fleet.load`, the toggle RPC, or any
agent's `turn_started`/`turn_ended`. Until then, after a plugin start, watches run and their output waits.

What the card shows and the queue itself are in `$PASEO_HOME/plugin-data/mission-control/watches.json`, so a
reload neither loses an output the script has already moved past (the PR watch's baseline has advanced)
nor reports a failure twice. A failure — non-zero exit, timeout, a script that will not start — is queued
once, with stderr's tail, and marks the watch `failing` until a run succeeds; its stdout is not sent. A
run is its own process group (`detached`), so a timeout's SIGTERM, and SIGKILL two seconds later, reach its
`gh` — the SIGKILL fires even when the script itself has exited, since a child that ignores SIGTERM and has
closed its pipes outlives it. A plugin stop aborts running scripts the same way, and starts nothing after,
even from a tick already in progress (`runWatchScript` checks an already-aborted signal before spawning). A watch still running when it is due again is
skipped, not queued.

**On and off is the daemon's config** (`disabledWatches`), not a settings document: the runner acts on it,
and a toggle from the card is `mission-control.watch.toggle`, read and written under `serialized` so two quick
presses cannot undo each other. The script is never touched.

**Built-in watches follow the plugin until edited**, like `prompts/charter.md`: each carries a
`mission-control-watch <fingerprint>` comment, and `seedWatches` (on `prepareHome` and every tick) rewrites an
untouched copy of an older version and keeps an edited one — the card says when the plugin's has moved on,
and deleting the file takes it. A deleted built-in is written again, which is why the card's switch is the
way to silence one. `pr-watch` is Node, with only dynamic `import()`s, so it runs whether Node treats the
extensionless file as CommonJS or ESM; its test (`server/pr-watch.test.ts`) seeds it into a temporary home
and runs it against a stand-in `gh` on a `PATH` of its own. It skips the backlog's `## Done` section,
subsections included, and comments by the account `gh` is logged in as — the crew's and the user's own.
It has to finish inside the runner's two minutes, so it looks up four pull requests at a time, starts none
after a 70-second budget, and takes the least recently checked first, saving what it checked: a long or
slow backlog is covered over a few runs instead of timing out on every one.

The watches are one line under the columns that opens into their list, and on a phone at the foot of the
Crew tab rather than in a tab of its own: it is looked at now and then, and a fifth tab does not fit a phone's width. A watch's
name opens its script (`watchPath`, the same `watches/` the server reads) through the surface's `openFile`,
the charter Compare's way into the Files view: the Files tab on a phone, the right-hand pane otherwise.

## Suggestions are Mission Control's, and a press sends one

`state/suggestions.md` is what the user might do next — `- <label> :: <prompt>`, one per line — and
Mission Control rewrites it whenever that changes (charter §2 and §9). The board reads it with the fleet
on every poll (`parseSuggestions`): notes are left out, a line without a label and a prompt either side
of the first `::` is skipped, and at most `MAX_SUGGESTIONS` are kept. Nothing in code writes a
suggestion; an empty or missing file draws no card and no tab.

The one thing code does to the file is take a suggestion out, for a card's trash button
(`mission-control.suggestion.remove`, `removeSuggestion` in `server/home.ts`). It is found by the label and
prompt the board showed, not by position, because Mission Control may have rewritten the list since the
board loaded it. Parsing and removal share one scanner (`scan` in `server/suggestions.ts`) that takes
notes out of the whole text, as the board always has, while remembering each visible character's
offset in the file: a note that splits a suggestion across lines is read the way the board reads it,
and removal deletes only that suggestion's own characters and its line break, never a note's bytes —
deleting the whole physical line could take a `<!--` with it and bring what the note hid onto the board.
A suggestion the file no longer has writes nothing. The write is `replaceTextIfUnchanged` in
`server/files.ts`: confined to the home, staged and renamed, and refused with `FileChangedError` unless
the file still reads exactly as it did — by content, since two writes in one millisecond share an
mtime — checked before staging and again just before the rename. A refusal is Mission Control writing
at the same moment, and the removal starts over from its version, `REMOVE_ATTEMPTS` times at most. A
write landing between that last check and the rename is still lost: a rename cannot compare and swap.
The Files view's own saves get the same second check, by modification time as before. The RPC answers
with the list left, which the board puts in the fleet query at once.

**A removal is remembered, because deleting the line alone does not stick.** Mission Control rewrites
the whole file from its records, and nothing in them said the user had removed a suggestion, so one
kept on the backlog came straight back, again and again. So before the line goes, `recordDismissal`
appends it to `state/suggestions-dismissed.md` as `- <label> :: <prompt> (dismissed YYYY-MM-DD)`, the
newest `MAX_DISMISSED` (50) kept and each prompt once, by its latest dismissal, written the same staged,
compare-before-rename way and started over when two removals race. The board leaves out of
`state/suggestions.md` any suggestion whose prompt matches a dismissed one, whitespace collapsed, before
counting to `MAX_SUGGESTIONS`, and never edits the file to do it. Recording comes first, so a removal that
then fails still hides the card. Charter §2 has Mission Control read the file before every rewrite, never
write a dismissed suggestion again, and say in new words what changed when one should come back — a new
pull request, new commits, a new decision — which the board shows, since the prompt no longer matches.
The file is a record from its template, so an existing home gets it on the next plugin start, and the
user lets a suggestion back by deleting its line there. Pressing a card is acting on it, not dismissing it:
the send never reaches this code, so nothing is recorded.

On the card, the trash is a sibling of the send `Pressable` rather than inside it, so pressing it can
never press the card. A removal on its way shuts that card by label and prompt, not position
(`client/suggestion-removals.ts`), since a poll can move it; identical twins wait together, and the gate
is checked synchronously, so two presses before a redraw start one removal. The gate is in module scope,
like the send gate, because the list unmounts on a phone's tab switch and on the wide layout's board/Files
switch while a request can still be out.

A button sends its prompt to Mission Control at once, and brings the chat into view to show it go out:
the Mission Control tab on a phone, the chat unfolded on a wide layout. The draft is not touched. The send is
the chat's own: `useCoordinatorSender` (`client/coordinator-send.ts`) is what Send, Status and Catch up go through too,
so a suggestion is the same `mission-control.coordinator.ask` with the same failure toast, the transcript echoes it
like a typed message, and a Mission Control agent mid-turn gets it the way `server/send.ts` delivers any message.
The sender's gate — one message on its way at a time — is per Mission Control in module scope, not in the
chat's state, because the surface's buttons and the chat both read it, and a phone switching tabs
unmounts the chat mid-send; the buttons are disabled while it is shut, and a double press that gets in
before the re-render is refused by it. A phone left on the Suggestions tab when the list empties shows,
and then switches to, Mission Control.

Only a card's main button sends. The chevron that opens the whole suggestion and the trash are its
siblings, not its children, so neither can press it. The chevron shows only when the folded card cuts
its label or prompt, and React Native cannot say that portably — `onTextLayout` is absent on the web
renderer and reports the whole text on iOS — so the card lays the same text out unclamped, invisible
and at the same width, and compares the two `onLayout` heights (`client/suggestion-fold.ts`). Until both
are in, the chevron shows.

## A held card answers the user's call

A backlog line can carry `(actions: <label> => <prompt> | …)`, the user's likely answers, which
charter §2 has Mission Control write on every `(hold: …)` item. The card draws each as a button under
"Needs you", on the board and in the card's view, sent through the board's sender — the one a suggestion
uses (`CoordinatorAsk`, built from `useCoordinatorSender` in `fleet.tsx` and in the panels) — so they share its one
message at a time, its failure toast and the chat coming into view.

**Anything else is said in the chat, pointed at the card.** A card's chat button, drawn on hover (always
on a touch screen), puts the card on Mission Control's composer as a pill (`client/chat-about.ts`) and
gives the box the cursor, switching a phone to the chat tab first; the message goes out as
`<id> — <title>: <typed text>` (`subject` in `client/card-commands.ts`), a worker with no task named by its
title, agent and host instead. The pill is module scope, so a chat that mounts after the press still finds
it and the focus request. There used to be an Answer box on every card; the one composer replaced them.
An open card's view puts its pill there too, marked `sticky`: it stays through every message sent and comes
off when the view closes, where a button's pill comes off with the message it went out with.

**Only the chat on screen takes the cursor.** `openScreen` leaves the screen it came from mounted and hidden
underneath (see the root AGENTS.md), so a second Mission Control screen means a second chat, subscribed to the same
pill and focus request — and the hidden one subscribed first, took the request and focused its own invisible
box (seen through a probe: the textarea was connected, `offsetParent` null, under an `aria-hidden` ancestor,
and the DOM refused the focus). The chat's pane reports its size through `onLayout`, and one with no size
neither claims the focus nor counts as the user looking for the New line.

A button inside a card's `Pressable` takes its own click, but a `TextInput` does not: react-native-web
fires `onPress` from the DOM `click`, which bubbles up from the box, so a click into a box inside the card
pressed the card (checked in Chromium through react-native-web), and a `View` claiming the responder does
not stop it. That is why the board's card has no box in it, and why the grip and the chat button are each
a `Pressable` of their own.

The field is the one backlog group whose value may hold parentheses and URLs, so `takeActions`
(`server/backlog.ts`) takes it out of the line before anything else is read. Only an `(actions:` outside
every other parenthesis is a field — one inside `(hold: …)` or a note is that group's text, and a stray
`)` outside any group is ignored. It runs from `(actions:`, any case, to its matching `)`; a backslash makes `\`, `|`, `(` and `)` literal and is kept before
anything else (`C:\Users`); every unescaped `|` separates buttons, spaced or not; a button splits at its
first ` => `, and one with no arrow, label or prompt is skipped. An unclosed field runs to the end of
the line and gives no buttons, and only the first field gives any — later ones are taken out all the
same.

## The home is called Mission Control in the sidebar, with a satellite dish for its icon

Paseo names a project and its workspace after their directory, and the default home is
`…/plugin-data/mission-control/home`, so the sidebar said "home" twice under a generic folder icon. `nameHome`
(`server/home-name.ts`) calls both "Mission Control" — the workspace through the SDK's `setTitle`, the project
through `paseo project rename`, since the SDK has no call for it. It runs on every launch and restart,
and — for a Mission Control agent launched before this existed — once per plugin process from the board's first
`mission-control.fleet.load`, only when Mission Control works in its home (an adopted agent's workspace
elsewhere is not the plugin's to name).
A title or project name the user set is kept, and the project is renamed only when its root is the
home itself: a home chosen inside another project keeps that project's name. A failure is logged and
never fails the launch or the board.

**The icon is a file, not a call.** Paseo looks for an icon in every project's own folder — `favicon.svg`,
`favicon.png`, `icon.svg`, `icon.png` and more, in `public/`, `assets/` and the like first and then the
root, square and 32 KB at most, an SVG taken as square (`project-icon.ts` in Paseo) — and shows it unless
an icon was uploaded in the project's settings. So `prepareHome` writes `icon.svg` into the home when it is
missing: the plugin's own sidebar satellite dish, white on blue (`templates/icon.svg`). The user can
replace it, in the Files view or on disk, or upload one in Paseo, which wins. An earlier build set the icon
with the daemon's internal `project.icon.set.request` instead; a project it reached keeps that upload until
it is reset to automatic in the project's settings.

Checked on a throwaway 0.9.1 daemon: a launch made both "Mission Control", Paseo served the home's `icon.svg` as
the project's icon with no custom icon set, and with the project reset to its directory name, a plugin
reload and one board load named it again.

## Interrupting needs the CLI

The handle has no cancel. `server/cli.ts` runs `paseo stop <id> --home $PASEO_HOME`, preferring
`PASEO_CLI` — the daemon hands its plugins the path of the CLI it shipped with (seen on 0.9.1) — and
falling back to `PATH` and the usual install directories.

## Mission Control can show a card in its reply

A line of its own reading `[[card: <task id>]]` — or a worker's agent id, whole or its first eight
characters and more — is a card embed (`parseMarkdown`'s `card` block, `CARD_EMBED`). The chat draws it as
the board's own `CrewCard`, looked up in the live board (`cardForRef`), so it shows where the work stands now,
not when the reply was written; pressing it opens the card's view in the board's place, bringing that pane or
tab into view, and its chat button points the composer at it. A ref the board does not have reads as "<ref>
is not on the board". Charter §9 tells Mission Control to embed the card of each task a message is mainly about,
on its own line, and that it is the one place a task id may appear. An embed inside a paragraph, a list, a
quote or a code block is that block's text. The chat is given the board's tasks (`BoardTasksContext`) for a
card's "Blocked by". A card on the composer's pill shows its worker's face.

## New messages are marked the way Discord marks them

When the chat comes into view — the screen opened, its tab chosen on a phone, a folded chat unfolded, or
Paseo's window focused again (`useAppFocused`: `AppState` active and, on the web, `document.hasFocus()`
with the window's focus and blur events) — Mission Control's messages since the last one seen sit under a
red "New" line and flash a wash of the warning colour that fades out (`FlashWash`). Only Mission Control's
own replies count. What lands while the user is looking is marked seen at once, so it never flashes,
and the first look with nothing recorded marks everything seen. "Seen" is the newest Mission Control message's
timeline sequence number, kept in the display settings as `chatSeen`, keyed by Mission Control, so it is
shared by every device on the host and survives a restart. The line stays until the chat unmounts or the
next return brings newer ones.

## Questions and permissions are answered in the chat

When Mission Control asks the user something (Claude's `AskUserQuestion`) or needs a permission, it
stops on a pending permission request. The chat draws each one at the end of the conversation and
answers it with `respondToPermission` from the client — the same call and payload the agent's own tab
sends, so nothing server-side is involved:

- **A question** (`kind: "question"`) is a form: one tab per question, options as radio buttons or
  checkboxes, a free-text box where the daemon added `allowOther`, and Dismiss / Next / Submit.
  `client/questions.ts` is a port of Paseo's `question-form-card-core.ts`, and the payload must stay
  identical to it: `allow` with `{ ...request.input, answers }` keyed by each question's **header**
  (the daemon re-keys them by question text for Claude), or `deny` with "Dismissed by user".
- **Anything else** is a card with the request's own `actions` as buttons, or Allow and Deny.

The request reaches the chat through the timeline: every timeline page carries the agent's snapshot,
pending requests included, and the request is itself a stream event, so it shows up with the next
re-read. The board's poll of Mission Control (`updatedAt` and the pending count) is a second trigger for
a re-read, for a request the stream did not announce. The "waiting for your answer" banner now shows
only when the chat is out of sight — folded, or behind the Crew tab — with a button that brings it back.

Checked on a throwaway 0.9.1 daemon: a Claude agent's AskUserQuestion arrived in the timeline page's
snapshot with `allowOther` set, and answering it with `buildAnswers` got "I picked Blue." back.

## The screen and its sidebar row

Paseo 0.11 replaced the static sidebar row and the bare surface with `addScreen` and
`addSidebarHeaderItem`, and both keep the old id, `fleet` (`FLEET_SCREEN_ID`): the sidebar item's id is
the key Settings › Sidebar keeps its order and hidden state under, and a saved
`/plugin/mission-control/sidebar/fleet` link resolves to a screen of that id. The screen is titled
"Mission Control" — the old surface's header read "fleet" — and every way in — the sidebar, "Open Mission Control",
"Mission Control: status", `/mc-status`, `/mc-catch-up` — is `openScreen`. Two things Paseo draws differently for a
non-legacy item, and nothing here can change: the screen header has no icon, and Settings › Sidebar
shows a generic plugin icon.

The item (`client/sidebar.tsx`) is the one Mission Control row, with a badge in `trailing`: how many crewmates
Paseo still runs have their card in the Working or the Idle column (`activeCrewCount`), and no badge at
zero. It reads **the board's own fleet query** (`useFleet`) rather than an agent observation of its own:
the screen, the panels and the item share one cache and one poll, and the count agrees with the
board's columns. The cost is that the poll now runs whenever the app shows this host — before, only
while the screen or a panel was open.

A row per crewmate was tried and dropped after the user used it: a backlog title is a sentence with
notes, and Paseo's row draws its label with no line limit, so the rows were paragraphs; one count says
what the sidebar needs to.

## Every worker has a face

`client/avatar.ts` hashes the agent id (FNV-1a, then a seeded mulberry32) into one pick of each part — species,
head shape, what is on top, the sides, eyes, mouth, cheeks — and a palette, and draws a 16×16 grid of `<rect>`s
as SVG markup, which the host's `Icon` takes as `{ svg }`. Paseo refuses `<style>` in it, so every colour is a
fill on its shape. **The colours are fixed hex, not theme tokens, on purpose**: a face is recognisable only if it
looks the same in every theme, and it sits on its own tile, so it reads on any ground. That is the one exception
to the root AGENTS.md's colour rule in this plugin, and it is confined to that file. Eyes that would vanish into
the head (lightness within 0.12) are drawn white or ink instead. A worker's card on the board is built around it, like a Scape list item:
the face on the left, and beside it the title (three lines at most) over a state line — an icon and word in
that state's colour from `workerState` (`client/worker-state.ts`), shared with the header below; the model
is the header's, not the card's — so the status line under it reads without its own "Done:" or "Blocked:". Links and the landed date
share one footer row. A task with no worker has the same card without the face or the state line. The face is drawn
at 36 points, with a dot in its corner only when the worker needs the user or failed (`WorkerAvatar`: amber for
a permission or attention, red for an error); a dot for working or idle repeated the column and read as a stray
mark. **The face moves a little**: a loop of two or three frames (`avatarFrame`, one tick every 250 ms, offset by the
agent's hash so a board does not move in step). A worker that needs the user (a pending request, or a card in Needs
you) raises a hand and waves it; a working one rests its chin on its hand, leaning in, blinking now and then and sitting
up. A waiting one dozes, a Zzz in the theme's muted colour floating up from its top right a z at a time. Idle and failed faces are still. Every face runs off one module-scope clock in `avatar-view.tsx`, which
stops when no face is animated, and each frame's SVG is made once. In a card's view the face heads the worker's transcript in the manner of Scape's session header
(`WorkerHeader`): the face; the worker's title and branch (`useWorkerBranch`, the same query the card's facts
use); its state with an icon in that state's colour; and on the right a context bar from the timeline snapshot's
`lastUsage`, with the host and the model as people say it (`modelName`: "Opus 5.5") under it. So the worker sits
over the work it is doing rather than beside the task's title. To look at a batch, write their SVG into one sheet and screenshot it with headless Chrome:
ImageMagick's own SVG renderer drops 1×1 rects, the eyes among them.

## A card's own view

**On the board a card keeps its corner buttons out of the way.** With a pointer they float over the card's
top-right while it is hovered, Notion's way, so the title has the whole width otherwise: an Inbox task's
Start (a quiet button that sends the request at once), the chat button and the grip. A touch screen has no
hover, so there they sit in the title's row. A right click — a long press on a touch screen, where the web
leaves long presses to the browser — opens the card's menu (`client/context-menu.tsx`): what the open card
offers to act with, grouped. Opening and the chat are left out, being a click and the card's own button away. A step that needs words or a confirmation (Relaunch…,
Waiting on…, End worker…, Drop task…) opens the card's view on it instead of acting from the menu; the view is
keyed afresh for it, so asking twice opens it twice.

Pressing a card opens it in the board's place — the right-hand pane, or the Crew tab on a phone — so the
chat with Mission Control stays beside it (`client/card-view.tsx`). Any card opens, a backlog item with no
worker too. On the left is the whole card (`CardSheet`): the summary, its facts, what its column asks the
user to decide, Interrupt and Relaunch, End or Drop. Under it are the user's notes on its task
(`client/task-notes.tsx`, `tasks/<id>/user-notes.md` through `mission-control.notes.read` and `.write`), saved as
they type and read by Mission Control, never written by it (charter §2). With a worker, on the right, is its
live transcript and a box at its foot that talks to it directly through `steerCrew`, so Mission Control
hears about it as it would a steer. Pressing *Crew* again, or the view's back button, returns to the board.
The open card is found again on each poll by its worker, or by its task when it has none (`openedRef`), and
a worker on a connected host stays open through a poll that could not reach that host. *Open in Paseo* is
in the view's bar. The workspace and agent panels draw the same `CardSheet`, without the view around it.

The transcript is `useAgentTimeline` on the crewmate, the tail of 200 projected entries, turned into
rows by `activityRows`. Where the chat folds Mission Control's machinery away, this keeps it: reasoning,
every tool call with an expandable detail (a shell command's output from its end, an edit's diff, a
file's content from its start, all clipped to 40 lines), and only the **latest** plan, because each
update restates the whole list. Claude's task tools reach the timeline as that plan
(`claude/task-state.ts` in Paseo); Codex, OpenCode and ACP providers send it directly. `hasOlder` on
the page says when the tail is not the whole story, and the view points at Paseo for the rest.

Rows — here and in the chat — are keyed by their entry's `seqStart` (`rowKey`). The entry's end grows
while a tool call runs or a reply streams, and its position in the page shifts by one with every new
entry once the tail is full; a key built from either remounts the row, which closes an open tool
detail just as its output arrives.

A crewmate's pending questions and permissions are answered here exactly as Mission Control's are in
the chat — `usePendingRequests` and `PermissionCard`, shared — and the transcript follows its end the
same way (`useFollowEnd`, also shared).

**Following the end is one flag, set only by scroll events** (`client/use-follow-end.ts`). Each scroll
event says whether the view is at the end (`isAtEnd`, from that event's own offset, viewport and content
height, within 40 points); a content change or a resize scrolls back to the end while the flag is on and never
touches it. That holds only because nothing else scrolls the view: the web's scroll anchoring, which moves it
by itself when a row above the end changes height (tool calls folding, "Working…" becoming the reply), is
switched off on the scroller (`disableScrollAnchoring`, `overflow-anchor: none`). With anchoring on, a probe
caught the view moving up 41 points mid-reply with nobody touching it, and the chat stopped following. Jumps
are instant, so no scroll event mid-animation reads as leaving the end. A round button over the transcript's
foot, as in Paseo's own agent view, goes back to the end while the reader is away from it.

## Debrief from a card

A worker whose workspace has changes can be opened in the Debrief review plugin, **on whichever host it runs**.
Whether it has changes is Paseo's `diffStat` on the workspace snapshot, read through the worker's own host's
Paseo (`host.api.workspaces.ref(id).refresh()`) and kept per worker until its `updatedAt` moves or a minute
passes (`server/debrief.ts`); on this Mac, Debrief's open comment count and whether it has a story come from its
files, `plugin-data/debrief/reviews/<workspaceId>/review.json` and `story.json`, read and never written.
**The size itself is never shown.** Paseo measures it from the merge base with the workspace's base branch as
that host has it, and on a remote host whose local base branch nothing updates, that came to millions of lines.

Opening is a **View diff** button in the card's view bar, **View diff** and **View story** at
the top of its right-click menu, and a **`[[debrief …]]` embed** (`client/debrief-embed.tsx`): on a line
of its own, `[[debrief: <task id, agent id or workspace id> <diff|story|plans> <path>]]`, every part
optional, parsed by `parseDebriefEmbed` and drawn as a "View debrief" button with the change's size and
open comments from the live board. Charter §9 has Mission Control offer one beside a card it hands the
user to review, and the brief has a crewmate end a ready message with a bare `[[debrief]]`, which in its
transcript in the card's view means that worker (`DebriefSelfContext`). Markdown with no board behind it
(the Files preview, a permission's summary) shows the embed as written; one that names work Debrief
cannot reach is a disabled button saying why.

**Opening goes through the app, not the daemon.** Paseo has no deep link to a plugin panel, `openPanel`
cannot name another host, and no plugin reaches another's RPC on another host. But every host's copy of a
plugin is evaluated in the same app, so each host's Debrief registers an opener for its own tab in a `Map` at
`globalThis[Symbol.for("debrief.openers.v1")]`, keyed by its host's `serverId` (`client/debrief-bridge.ts`
reads it). The screen opens the worker's workspace with `navigation.openWorkspace({ workspaceId, serverId })`
and calls that host's opener; this Mac's own `serverId` is `paseo.hosts.list().self`. A remote card shows its
buttons only while its host's opener is registered (`BoardTasks.canDebrief`). For this Mac with no opener
registered, the fallback is the older mailbox: `mission-control.debrief.open` writes
`plugin-data/debrief/open-requests/<nonce>.json` (`{ workspaceId, agentId?, view, path?, createdAt }`,
Debrief's `OpenRequestSchema`), staged under a dot-name and renamed so Debrief, which claims only `*.json`,
never reads half of one, and Debrief's panel claims it on its poll.

## The home's files, in the panel

A Files view — beside the crew board on a wide layout, a third tab on a phone — lists the home folder by
folder and opens any text file in an editor, with a Markdown preview for `.md`. Three calls in
`shared/files.ts`, handled in `server/files.ts`, and a fourth for the chat:

- **Confined to the home, twice over.** A path is normalized and refused if it is absolute or climbs
  above the home; then it is resolved through symlinks and refused if it lands outside the home's real
  path — for a file about to be created, through its nearest existing ancestor. A link in the home can
  point anywhere, and the panel must not follow it out.
- **Saved against the version opened.** Mission Control writes these same files, so a save carries the
  modification time the editor opened the file at and is refused if the file has changed since; the
  editor then offers *Overwrite*, which sends `force`. A file that changes on disk while open and
  unedited is reloaded quietly, off the list's ten-second poll. A save is a temporary file renamed over
  the old one, so Mission Control never reads half of it.
- **Text only, up to a megabyte.** A NUL byte in the first 8 KB marks a file binary; either kind is
  listed but not opened.
- **The chat links only what the daemon vouches for.** `client/file-links.ts` picks anything
  path-shaped out of Mission Control's replies — plain text, inline code, a Markdown link's target,
  never a fenced code block; a `/` or an extension, a trailing `:line` dropped, at most 1024
  characters — and `mission-control.files.find` answers which are files, through the same confinement,
  absolute paths included when they sit under the home. One query for the whole conversation, the
  500 most recently mentioned paths, re-asked every 30 s so a file named before it was written
  becomes a link. Opening one unhides a hidden right pane. The user's messages are plain `Text`, not the Markdown renderer, so they are not linked.

`AGENTS.md` opens with a note that the plugin rewrites it on every start, pointing at
`prompts/user.md` for anything that should last. The open folder, the open file and its unsaved text
are kept in module scope, like the chat's draft, so a remount does not lose an edit in progress.

Errors from any RPC reach the app wrapped as `Request failed: … requestType=… code=…`;
`errorText` (`client/format.ts`) strips that, so the panel shows the handler's own sentence.

## Context, Compact and Restart

The composer's toolbar ends with how full Mission Control's context window is, the way Paseo's composer
shows it: `lastUsage.contextWindowUsedTokens` over `contextWindowMaxTokens`, read from the agent snapshot
every timeline page carries (so it moves with the stream, and the board's poll re-reads it too), coloured
at Paseo's thresholds — a warning from 70%, danger past 90%. Paseo draws its ring in SVG, and
`react-native-svg` is not a module a plugin may import, so `ProgressRing` builds the same ring from views:
each half of the circle is an `overflow: hidden` clip holding a ring whose border is coloured on two
adjacent sides only — a rounded border splits its sides at the diagonals, so that is exactly half a ring —
rotated so the coloured half slides into view clockwise from the top. At 0% the fill is not drawn at all,
since its edge showed as a hairline on the seam. Rendered through react-native-web in Chromium at 0–100%
and at 14 points to check the angles; iOS and Android draw per-side border colours on a rounded view the
same way, but have not been looked at. Before the first turn ends there is no usage to draw, and a
"more" icon stands in for the ring.

The ring is all the toolbar shows, as in Paseo. Pressing it opens a small menu above it with the share,
the tokens, Compact and Restart (`client/coordinator-controls.tsx`), so the toolbar keeps to the everyday buttons
— attach, Status, Catch up, Send — inside the one box the composer is. The menu has a fixed width because
an absolutely positioned view is measured against its parent, the 28-point ring, and would wrap to it.

- **Compact** (`mission-control.coordinator.compact`) sends `/compact`, the command Paseo's own composer sends; Claude
  Code (a root-only command there, and Mission Control is a root agent), Codex and OpenCode each compact on
  it. It is a plain send and refused while a turn runs — the button is disabled then, and the daemon
  refuses too: a slash command must be a turn of its own, where a send would interrupt the running turn
  and a steer would bury the command inside it. The compaction's
  two timeline entries — started, finished — fold into one line (`pushCompaction`).
- **Restart** (`mission-control.coordinator.restart`) archives Mission Control and launches a new one in the home with
  the live agent's model, mode and thinking — not the config's, since they can be changed in its tab and
  an adopted Mission Control has none there — and the opening followed by the restart note, which tells it it is
  taking over. Archived
  *first*, under the same lock as a launch, so two Mission Control agents never run at once; a launch that
  then fails leaves none, and says so. Archiving retires its wake, because Paseo completes a schedule
  whose agent is archived; the conversation stays readable in Paseo's history. Refused mid-turn, like
  Compact, button and daemon both: a turn cut off halfway through a dispatch can leave a crewmate the
  records never heard of.

What a restart costs: **crewmates the old Mission Control started no longer wake anyone.** Paseo's finish
notification goes to the agent that created or prompted the crewmate and is dropped when that agent is
archived (`setupFinishNotification` in Paseo returns early for an archived caller), and archiving a Mission
Control also takes the parent label off its cross-workspace children — which is why Herald 0.5 announces
them from then on. The restart note and charter §3 have the new Mission Control set up its own wake at once, and
§7's crew check on every wake is how it finds out.

Checked on a throwaway 0.9.1 daemon with a Haiku Mission Control: 33,969 of 200,000 tokens after launch,
4,949 after Compact, and Restart archived it and brought up the same model and mode, with the config
pointing at the new one.

## Opening the panel marks Mission Control seen

While the surface is mounted, a Mission Control agent flagged "finished" or "error" is cleared the way opening
it in Paseo clears it, so its workspace reads as done in the sidebar (`deriveAgentStateBucket`: an
idle agent without `requiresAttention` is `done`). The effect is keyed by the agent's `updatedAt`, so
a turn that ends while the panel is open is cleared too, and a failed clear is not retried until
something changes. A Mission Control agent waiting on a permission keeps its flag — Paseo's own "mark as read"
(`workspace.clear_attention`) skips those too, because the flag is the prompt to answer it.

The SDK has no call for it, so `server/daemon-session.ts` writes a `clear_agent_attention` session
message on the plugin's own IPC channel — the frame envelope the plugin's `DaemonClient` already
uses — and waits for the response carrying its own `requestId`. That is the protocol, not an
interface: a daemon that changes the message answers with a timeout, which is logged and costs
nothing. Only complete, valid session messages go this way; a malformed frame is a protocol
violation, and the daemon closes the socket every other call from the plugin rides on.

## A crewmate Mission Control has read about leaves "Ready to review"

Paseo's sidebar puts a workspace in "Ready to review" while one of its agents has `requiresAttention`
set, which the daemon does on every running → idle transition (`attentionReason: "finished"`), and
leaves it there until someone looks at the agent. Nobody looks at a crewmate in Paseo — Mission Control
reads about it in the `<paseo-system>` finish note — so without help every crewmate Mission Control
ever ran piled up there.

**The note is not in any timeline a plugin can read.** The daemon drops every user message that is a
whole `<paseo-system>` envelope (`isSystemInjectedEnvelope` in Paseo's agent manager) before recording
it, so neither `turn_ended`'s `timeline` nor `paseo logs` ever shows one, even though the provider's
own session holds every note. The first version parsed the notes out of the hook's timeline and so
never cleared anything. Checked on the live 0.9.1 daemon: Mission Control's Claude session held 23 notes,
its Paseo timeline none.

So `server/crew-seen.ts` goes by time. It hooks **Mission Control's** `agent.turn_started` and
`agent.turn_ended`: when a Mission Control turn *completes*, every crewmate Mission Control created
(`pmc.role=crew` and Paseo's own `paseo.parent-agent-id` set to Mission Control — the note goes to
the creator) whose `attentionTimestamp` is no later than that turn's start is cleared, the same way
`markCoordinatorSeen` clears Mission Control. The daemon sets the flag before it sends the note, and the note
either starts a turn or is steered into a running one, so a finish from before a turn started has
reached Mission Control by the time that turn completes. A finish during a turn waits for the next one.
The Mission Control hooks rather than the crewmate's own `turn_ended`, because that fires from the
crewmate's stream and can run before the daemon sets the flag. A cancelled or failed turn leaves the
work for the next completed one, and a turn whose start the plugin did not see — one running across a
reload — is skipped. Each clear logs `cleared N crewmates` to `paseo plugin logs mission-control`.

Only a crewmate of this Mission Control whose flag is still `"finished"`, with no pending permission, not
running and not in error, is cleared. A permission or an error still reaches the user, and Paseo
ranks both above the flag regardless. Mission Control itself does nothing, so the charter is unchanged.

**This relies on Paseo's internal message format, like `markCoordinatorSeen`**: `clear_agent_attention` over
`server/daemon-session.ts`, because neither `PaseoApi`, the MCP tools nor the CLI can clear attention
in 0.9. A daemon that changes the message answers with a timeout, which is logged, and crewmates go
back to waiting in "Ready to review". The follow-up is an upstream API — an `agents.clearAttention`
(or `workspaces.clearAttention`) on `PaseoApi` — and moving both callers onto it.

## Phones: the home indicator and the keyboard

The host pads a surface's top, under its header, and nothing else: not the home indicator, and not
the keyboard — Paseo moves its own composer with `react-native-keyboard-controller` and
`react-native-safe-area-context`, and neither is a module a plugin may import. So the chat does both
itself, with what `react-native` offers:

- **The home indicator.** The composer is wrapped in `SafeAreaView` (deprecated in React Native
  0.81, still present). It replaces the padding in its own style, which is why the composer's padding
  is on the view inside it. It does nothing on Android.
- **The keyboard.** `useKeyboardOverlap` (`client/keyboard.ts`) measures the chat pane with
  `measureInWindow` — the space the keyboard's frame is reported in — and the pane pads its bottom
  by the overlap. `KeyboardAvoidingView` is not used because it measures against its parent, which
  inside the host's screen needs an offset nobody here knows. Lifted above the keyboard, the composer
  no longer overlaps the home indicator, so its safe-area padding drops to zero instead of stacking.
- **The lists with text boxes in them** — the compact board, the panels, the launch screen,
  settings — use `automaticallyAdjustKeyboardInsets`, iOS-only, which insets a `ScrollView` and
  scrolls the focused box into view.

All of it was written against a screenshot and has to be checked on a device.

## Attachments go the way Paseo's composer sends them

Paseo 0.9 gives a plugin no composer to embed: composer pills and attachment sources contribute *to*
Paseo's own composer, and `@getpaseo/plugin/client/*` exports no input, picker or chip. So the chat
has its own, and sends what Paseo's composer sends (read in the 0.9.0 app and daemon):

- **An image** goes in the send's `images`, base64 with its type — raster types only, by Paseo's list;
  an SVG is a file.
- **Any other file** is written to `$PASEO_HOME/uploads/upload_<uuid>/<safe name>` and goes in
  `attachments` as `{ type: "uploaded_file", id, fileName, mimeType, size, path }`; the provider tells
  the agent the path. Paseo's app uploads over a binary channel a plugin cannot reach, so the bytes
  ride the `mission-control.coordinator.ask` RPC as base64 and `server/uploads.ts` writes them in Paseo's layout —
  only once Mission Control is known to exist. Paseo caps one file at 50 MB and nothing else, since each
  upload is its own stream; here one RPC carries the whole message in one WebSocket frame, and the
  daemon's socket takes `ws`'s default 100 MiB. So the contract holds images and files alike to 50 MB
  each, 20 per message and 64 MB together (about 85 MiB as base64), and the client checks the same
  before it reads a byte.

Picking, pasting and dropping are all `client/web.ts`, and **all of it is web-only**. Paseo's native
app picks with Expo's image and document pickers and pastes through a third-party text input; none
of those is a host module, so on iOS and Android the attach button is not drawn and the chat takes
words only. A phone *browser* gets the button, and its picker offers the photo library and camera.
Paste takes images only, as Paseo's does, so pasting text or a copied file still pastes text.

The pending attachments live beside the draft on `globalThis` (`client/attachments.ts`), bytes and
all, so a lost connection keeps them; a failed send puts them back unless something new was attached.

## What was left out

From FirstMate the distro: the session backends (tmux, Herdr, cmux, Zellij, Orca), treehouse, the
watcher and its wake queue, secondmates, Relay, `/afk`, calm mode and self-update — each is either
plumbing Paseo replaces or a feature for another day. `no-mistakes` is an external tool; its place is
taken by a `reviewed-PR` mode the crewmate carries out itself.

From ABorakati's plugin: changing Mission Control's model, thinking or mode from the board (0.9's SDK
cannot; ABorakati's plugin sent raw daemon frames over the plugin's IPC channel, which is not an
interface — Paseo's own agent view does it), and dragging columns (arrows instead). Attachments came
later, web-only — see *Attachments go the way Paseo's composer sends them*.

## Checking it

`npm test` covers the parsers, the column rules, the card join, the charter's placeholders, the home's
write-once records, the relay text, the transcript rows, the card order, and the watches — schedules,
the runner's queue and guardrails, seeding, and `pr-watch` against a stand-in `gh`. What it cannot cover,
check against a **throwaway daemon** (see the root AGENTS.md — never the real one, whose agents are
the user's):

1. `paseo plugin install "$PWD" --home /tmp/paseo-check`, then `paseo plugin ls --home /tmp/paseo-check`:
   `running`. The daemon sets `PASEO_HOME` for its plugins, so the plugin's files land under the
   throwaway home even when the shell's `PASEO_HOME` names the real one.
2. A throwaway `*.tmp.test.ts` can drive every RPC the way the app does:
   `new DaemonClient({ url: "ws://127.0.0.1:6799/ws", clientType: "cli", … })` from
   `@getpaseo/client/internal/daemon-client`, then `client.invokePluginRpc("mission-control", "<wire name>",
   input)`. Delete it afterwards.
3. The loop worth watching once per charter change: launch a Mission Control agent with a capable model, register
   a scratch `local-only` repository in `state/projects.md`, ask for a one-line change, and watch a
   crewmate appear on the board in its own worktree, report `done: ready in branch mc/<id>`, and the
   Mission Control relay it.
4. Then look at the screen and the sidebar row's badge, wide and compact, in two themes — there is no
   harness for plugin UI.
