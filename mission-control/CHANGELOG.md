# Changelog

Notable changes to `mission-control`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Run buttons in Mission Control's replies.** `[[run: <project> :: <command>]]`, or `[[run: <command>]]`
  for Mission Control's home, on a line of its own is drawn as the command in a code block with a run
  button. Each press runs it once in a new Paseo terminal in that project's folder, and the pill shows
  it running, then its exit code and last lines, with Open terminal, Stop and a copy button. A project
  Paseo does not have is refused by name. The charter tells Mission Control to offer one for trying
  something out, beside the same command in plain text.
- **Images in replies.** A Markdown image, `![caption](path)`, in Mission Control's chat or a worker's
  transcript is drawn inline, fitted to the column, with its caption; several on consecutive lines sit
  side by side, and a press opens one full size. It can be a file in Mission Control's home (relative or
  absolute), a file inside a registered Paseo project (`C:\…`, `C:/…` or `file:///…`), or an `https://`
  image. The plugin sends local files only from the home and the project roots, checked through `..`
  and symlinks, as PNG, JPEG, GIF or WebP up to 8 MB, fetched as they scroll into view. A missing,
  outside, too large or unsupported image shows a placeholder saying which. The charter tells Mission
  Control when to show a screenshot inline.
- **Images in the Files view**, instead of "not a text file". A Markdown preview draws its images and
  links relative to the file's own folder.

### Fixed

- **Links in replies.** Windows paths (`C:\Users\…`), `file:///` URLs and `name.md:12` are linked; a link
  inside bold text works; a URL with parentheses keeps them; a link to a file in a registered Paseo
  project shows it in the file manager; and a link to a missing file reads as its text instead of
  opening a broken address in the browser. Worker transcripts and the Files preview link files too.

## [1.0.0] - 2026-11-06

The first version.

- **One agent runs the crew.** Mission Control takes your requests, starts a worker for each task in
  its own Paseo worktree, supervises it with Paseo's own finish notifications, and brings you pull
  requests, findings and only the decisions that are yours. It never merges without your word unless a
  project allows it.
- **A board beside the chat.** Every worker as a card, by where it stands (Inbox, Needs you, Working,
  Waiting, Idle, Done and more), with a face that shows its state. Drag cards to set priority; open one
  for its notes, its live transcript and a box to talk to it; right-click for what it offers.
- **Records on disk**, in a home the Files view opens: your standing orders (`prompts/user.md`), the
  charter (`prompts/charter.md`, yours to edit, with a comparison when the plugin's changes), the backlog,
  the project registry, suggestions, learnings, and a folder per task under `tasks/`.
- **Links on every task**: its pull requests, in stack order, and one `(source: …)` for the ticket or
  thread it came from. Mission Control matches incoming PRs and tickets to the task that has them.
- **A wake**, in `prompts/wake.md`: a schedule (every 15 minutes from 9:00 to 17:45 on weekdays, to begin
  with) and your own steps. Mission Control keeps one Paseo heartbeat on it, set up when it takes over.
- **Watches**: scripts in `watches/` the plugin runs on a schedule, which reach Mission Control only when
  they print something. `pr-watch` reports merges, reviews, comments and checks on the backlog's pull
  requests.
- **Status and Catch up** from the chat's buttons, ⌘K, and `/mc-status` and `/mc-catch-up`; `/mc`
  talks to Mission Control from anywhere in Paseo.
- **Debrief** from a card's menu and view, and `[[debrief: <task>]]` buttons in messages, on whichever
  host the work runs.
- **Workers on every connected host**, found by their `pmc.*` labels.
