# Mission Control

A [Paseo](https://paseo.sh) plugin: talk to one agent, ship with a crew.

You talk to a single agent, **Mission Control**, and it runs the crew for you. Every task goes to a
**worker**: its own Paseo agent, in its own git worktree, so parallel work on one repository never
collides. Mission Control writes each worker's instructions, supervises it to the end, and brings you
finished pull requests, investigation findings, and only the decisions that are really yours.

A **Mission Control** panel in the sidebar puts the conversation with Mission Control beside a board of its
crew — Queued, Working, Blocked, Parked, Done, Failed and Idle — with each worker's last word on what
it is doing and a link to its pull request. The sidebar row shows how many workers are working or idle.


This is a Paseo-native take on [firstmate](https://github.com/kunchenguid/firstmate) by Kun Chen, by
way of [ABorakati/paseo-firstmate](https://github.com/ABorakati/paseo-firstmate). Where those run the
crew in terminal sessions and supervise it with shell scripts, this one uses nothing but Paseo: the
workers are ordinary Paseo agents you can open, read and type into like any other, in worktrees Paseo
manages, and Paseo itself tells Mission Control when a worker finishes, fails or asks for permission.
There is nothing else to install.

## What you need

- Paseo **0.13 or newer**, on the daemon and on the device running the app.
- **Paseo's agent tools turned on.** They are how Mission Control starts its workers and hears back from
  them, and Paseo ships with them off. The panel says so and turns them on with one press; it is the
  *Agent tools* switch in the Mission Control settings too.
- A capable model for Mission Control. It spends its day reading records and deciding who does what,
  and a small model gets the tools wrong. Claude Sonnet or better, or a comparable Codex model, works.
- The `paseo` command on the daemon machine, which a Paseo install puts there. It is used to find the
  plugin's own files, to interrupt a worker from the board, and to name Mission Control's project in
  Paseo's sidebar.

## Install

```bash
paseo plugin add git:evaera/paseo-plugins:mission-control
```

Add `--ref <tag or commit>` to pin a version; tags are `mission-control/v<version>`. Install it on
the machine you run Mission Control from; its workers can be on any host the app is connected to.
For **View diff** on a worker's card, install [Debrief](../debrief) too, on every host workers run on.

To work on it, clone the repository and run `paseo plugin install "$PWD"` from this folder after
`npm install` and `npm run typecheck`. Everything the plugin writes into Mission Control's home — its
charter, the records it starts with, the home's icon — is in `templates/`, as the files it becomes;
`paseo plugin reload mission-control` puts a change to work.

## Getting started

1. Open **Mission Control** in the sidebar, pick Mission Control's model, and press **Launch Mission Control**.
   If you already started an agent for the job, adopt it from the list below the button instead.
2. Tell it about a project: "the web app is at ~/code/web — ship through pull requests". It keeps a
   registry, so you only say this once.
3. Ask for work: "fix the flaky login test and add dark mode". Two workers appear on the board, each in
   its own worktree. Minutes later:

   > PR ready for review, user: https://github.com/you/web/pull/42 (fix the flaky login test - risk: low - CI green)

4. "Merge it." Mission Control never merges without your word, unless you have told it a project may.

## Talking to Mission Control

- The chat in the panel — Enter sends and Shift+Enter starts a new line, as in Paseo — or open
  Mission Control's agent in Paseo for the whole session, every tool call and its output. The chat follows new
  messages while you are at the bottom; scroll up to read, and the round button at the bottom brings
  you back. A file in the home that Mission Control names in a reply is a link that opens it in the
  Files view.
- **How full its memory is** — the ring at the end of the chat's buttons shows how much of Mission
  Control's context window is used, the way Paseo's own chat does: amber from 70%, red past 90%. Hover
  over it, or tap it on a phone, for the share and the token counts.
  **Compact** has it summarise its conversation to free room, as `/compact` does in Paseo. **Restart**
  starts a new Mission Control from scratch, with the same model and settings, after asking you. Both wait
  until Mission Control is between turns. On a restart its records carry over, the old conversation stays in
  Paseo's history, and workers already running keep going — the new Mission Control checks on them
  regularly, since Paseo tells only the agent that started a worker when it finishes.
- **Questions it asks you** — which option, whether to go ahead, a plan to approve — appear in the
  chat as a form you answer there, the same as in Mission Control's own tab.
- **`/mc <message>`** in any composer sends the message to Mission Control, from wherever you are.
- **`/mc-status`** — where everything stands, in four sections: what needs your call, what landed,
  what is in progress, and what is next. `/mc-status file` also writes it to a dated report in Mission
  Control's home; `/mc-status include PRs` checks the live pull requests too.
- **`/mc-catch-up`** — what happened since you last spoke, then every open decision, one at a time, with a
  recommendation.
- *Status* and *Catch up* are also buttons above the chat, and *Mission Control: status* is in ⌘K.
- **Suggestions** — when Mission Control has an idea of what you will want next ("Land web#42", "Review
  loop on web#42"), it shows as a button: on a wide screen in a card before the board's columns, on a
  phone in a Suggestions tab after Mission Control. Pressing one sends that request to Mission Control right
  away, just as if you had typed it and pressed Send, and brings the chat into view so you see it go
  out; anything you were typing stays in the message box. A suggestion too long to show whole gets a
  chevron that opens the full request below it, to read or copy, without sending it. The trash button
  beside a suggestion takes it off the list without sending it, and Mission Control remembers that: Mission
  Control will not suggest it again, and the board hides it if it does. When something about it changes —
  a new pull request, say — Mission Control can suggest it again in new words, and that shows. With no
  suggestions there is no card and no tab.
- **Answering the user's call** — a card waiting on your decision ("Your call: merge web#42?")
  shows Mission Control's likely answers to it as buttons under that line ("Merge", "Hold"). Pressing one
  sends that answer to Mission Control right away, the same way a suggestion does. Under them, every
  waiting card has an Answer box: type what you want, in your own words, and Send; it reaches Mission
  Control with the task's name in front, so it knows which decision you mean.


## The board


Each card is a worker, a backlog item, or both. Press one for its actions:

- **Watch** — the worker's card beside everything it is doing, live, in place of the board: the brief
  it was given, its reasoning, each command and file it touched (press one for what it ran and what
  came back), its plan, and its replies. Anything it is waiting on — a question, a permission — is
  answered there. The chat with Mission Control stays beside it; **Crew** takes you back to the board,
  and **Open in Paseo** shows the worker's whole session.
- **Steer** — a word straight to the worker. It counts as coming from you, and Mission Control is told
  what you said and what the worker answered.
- **Interrupt** — stops the worker's current turn.
- **Relaunch** — asks Mission Control for a fresh worker in the same worktree, with your note. The work
  on disk carries over; the conversation does not.
- **End** — archives the worker. Its workspace and worktree are left exactly as they are.


A column with nobody in it is hidden, so the board shows only what has workers in it. On a wide
screen up to three columns sit side by side; past three they take two rows, with the extra one in the
second row. Columns fold to a strip and move with the arrows in their headers, and the split between
chat and board drags. The layout is remembered, including where a hidden column goes when it fills
again.

Opening the panel counts as looking at Mission Control: when it has finished a turn, its workspace in
Paseo's sidebar turns to done, as it would if you had opened Mission Control itself. One waiting on
your permission stays flagged until you answer.

A worker's workspace and session also get a **Mission Control** tab showing its card, with a box for telling
Mission Control something about it.

## Mission Control's home

The **Files** view — next to the crew board, or its own tab on a phone — shows everything in the home
and opens any text file for editing, with a preview for Markdown. Cmd/Ctrl+S saves on a desktop. The
Mission Control writes these files too, so a save never silently replaces its newer version: you are told
it changed, and choose to load theirs or overwrite it with yours.

Mission Control lives in a directory of its own — by default inside Paseo's plugin data, or anywhere you
choose in the settings. It writes there and nowhere else; your projects are read-only to it, and every
change is a worker's job.

In Paseo's sidebar Mission Control's project and workspace are called **Mission Control** rather than after
the folder, and the project shows Mission Control's satellite dish, from `icon.svg` in the home — Paseo picks up a
project's icon from its folder. Rename either, replace the file, or upload an icon in the project's
settings, and your choice is kept.

Your instructions to Mission Control are in `prompts/`, what it keeps up to date is in `state/`, and
each task has a folder under `tasks/`.

- `AGENTS.md` — its charter: how it takes requests, briefs and supervises workers, and talks to you.
  Written from `prompts/charter.md` every time the plugin starts or Mission Control is launched, so do not
  edit it here.
- `prompts/charter.md` — **the charter itself, yours to change.** It starts as the plugin's own charter, and
  while you leave it alone, a new version of the plugin brings its improvements. Once you edit it, your
  version is kept; if Mission Control's charter changes after that, the board tells you, **Compare** opens the
  new one beside yours (`prompts/charter.new.md`) and **Done** marks yours up to date. Saving it in the panel
  rewrites `AGENTS.md` at once; Mission Control reads it at its next session, or when you ask it to re-read
  its charter. The note at the top lists the `{{placeholders}}` filled in for you, notes between `<!--`
  and `-->` are left out, and an empty file goes back to Mission Control's charter.
- `prompts/user.md` — **your standing orders.** Anything you write here outranks the charter (except
  its hard rules: it never writes to a project, never merges without your word, never throws away
  unlanded work). Never overwritten.
- `prompts/wake.md` — **when Mission Control wakes on its own, and what it does then.** A `schedule:`
  crontab line (every 15 minutes from 9:00 to 17:45 on weekdays, to begin with; `off` for none) and a `timezone:`,
  then your own steps: the channels, trackers or dashboards to look at. Mission Control keeps one Paseo
  heartbeat named "Mission Control wake" on that schedule, sets it up when it takes over and changes it
  when you change the file. Every wake checks the crew, and pull requests when the PR watch is off or
  failing, before your steps. A wake is a turn and costs tokens; a check a script can do belongs in a
  watch (below), which costs nothing until it finds something. Never overwritten.
- `state/projects.md` — the project registry, and how each one ships:
  - `direct-PR` — the worker opens a pull request ready for review;
  - `reviewed-PR` — the worker also reviews its own diff, runs the full test suite and waits for CI;
  - `local-only` — no remote; the worker leaves a clean branch, and Mission Control lands it when you say.
  - `+yolo` after the mode lets Mission Control merge green work on that project without asking.
- `state/backlog.md` — every task, in flight, queued and done. The board reads it.
- `state/suggestions.md` — what Mission Control thinks you will want next, one per line as
  `- <label> :: <what to send>`. Mission Control keeps it up to date; the board turns it into buttons.
- `state/suggestions-dismissed.md` — the suggestions you removed from the board, the newest 50. The
  board hides any suggestion with the same words, and Mission Control reads it before writing new ones.
  Delete a line to let that suggestion show again.
- `state/wake-state.md` — what Mission Control keeps between wakes: the wake's heartbeat id, and whatever
  your steps need remembered, such as the last message read in a channel.
- `tasks/<task>/` — each task's folder: `brief.md`, the worker's instructions; `report.md`, an
  investigation's findings; Mission Control's `notes.md`; and your `user-notes.md`, from the card.
- `watches/` — scripts the plugin runs on a schedule; see below.

Because all of it is on disk, a restart is a non-event: Mission Control reads its records, checks them
against the live crew, and carries on.

## Watches

A **watch** is a small script in the home's `watches/` folder that the plugin runs on a schedule, while
Paseo is running. When it prints nothing, nothing happens; when it prints something, all of it reaches
Mission Control as one note, as soon as it is between turns — several at once arrive together, and the
chat shows them as one line naming the watches. The plugin adds nothing to what a watch prints, so it
reaches Mission Control as the script's own words: since the script is yours, what it says to do,
Mission Control takes as your instruction. A watch that passes on text from someone else — a pull request
comment, a web page — has to mark it as quoted, and Mission Control treats what is marked that way as
news, not orders. `pr-watch` does, and says so.

Mission Control comes with one, **`pr-watch`**, which checks every five minutes on the pull requests in the
backlog — yours and those to other people's projects — and tells Mission Control when one is merged or
closed, gets a review or a comment from someone else, or its checks go red or green. So a pull request
you merge on GitHub is cleaned up within minutes, and a maintainer's review reaches the worker without
you passing it on. It needs the `gh` command, logged in, and Node, on the machine Paseo runs on.

A **Watches** card after the board's columns — at the bottom of the Crew tab on a phone — lists each
watch with its schedule, when it last ran and what came of it, and what it last said (press it to read
it all). Its switch turns a watch off or on without touching the script, and a watch's name opens the
script in the Files view. A watch that fails is reported
to Mission Control once, and shown on the card until it works again.

To write your own, put an executable script in `watches/` with its schedule in a comment near the top,
crontab style, in the Mac's local time:

```sh
#!/bin/sh
# schedule: 0 9 * * 1-5
```

`watches/README.md` in the home has the details: the schedule syntax, and what a script is given to find
the home, the backlog, and a folder of its own to remember what it has already reported. Until you edit
`pr-watch`, a new version of Mission Control replaces it; once you have, yours is kept, and the card says when
Mission Control's has changed. Mission Control adds or changes a watch only when you say so.

## Settings

**Settings › Plugins › Mission Control** — or the gear in the panel's header, or *Mission Control settings* in ⌘K.

- **Mission Control** — which agent it is, and *Release* to forget it (the agent keeps running).
- **Home directory** — where Mission Control lives. It can be moved only while no Mission Control agent is running.
- **Crew model and mode** — what every worker runs, unless you tell Mission Control otherwise for a
  task. "Let Mission Control choose" gives workers its own model.
- **Agent tools** — Paseo's switch, described above.
- **Refresh every** — how often the board polls.

## Limitations

- **Nothing is merged or thrown away without you.** Workers push their own branches and open pull
  requests, but merging needs your word (or `+yolo` on that project), and a worker's worktree is only
  cleaned up after its work has landed.
- **A worker you prompt by hand** in its own tab is not watched by anyone until Mission Control next
  reviews the fleet (it keeps a half-hourly check while work is in progress). Steer from the board
  instead, and Mission Control hears about it.
- **Mission Control's model, thinking and mode** are changed from its own tab in Paseo, not from the
  board.
- **Attachments** — images, files — go to Mission Control from its own tab, not from the panel's chat.
- **Watch shows a worker's latest activity**, not its whole history; a long-running worker's earlier
  work is in its own session in Paseo.
- It does not reproduce firstmate's second mates, relay to X and Discord, away mode, or the
  `no-mistakes` pipeline (`reviewed-PR` stands in for the last).
- **Watches run only while Paseo does**, and a run missed while the Mac was asleep is not made up. After
  the plugin is reloaded, what a watch prints waits until any agent works or the panel is opened.
- The panel has not yet been checked on a phone.

## License

MIT — see [LICENSE](LICENSE).
