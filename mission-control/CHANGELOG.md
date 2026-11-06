# Changelog

Notable changes to `mission-control`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
