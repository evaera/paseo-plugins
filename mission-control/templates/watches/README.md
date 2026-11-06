# Watches

Scripts the Mission Control plugin runs on a schedule while Paseo is running. A script that prints nothing
costs nothing; whatever a run prints is sent to Mission Control, as one `<mission-control-watch>` note, once
it is between turns. The Mission Control board's Watches card lists them, with each one's last run, and
switches any of them off or on.

This file is the plugin's, written once and then yours. It is not a watch, and neither is any other
`.md` file here or a name starting with a dot.

## Writing a watch

A watch is a script in this folder, run as it is, so it needs a `#!` line and to be executable
(`chmod +x`). In its first 20 lines it names its schedule in a comment:

```sh
#!/bin/sh
# schedule: */5 * * * *
```

`//` and `--` comments work too. The schedule is a crontab line — minute, hour, day, month, weekday
(Sunday is 0 or 7) — each field `*`, a number, `a-b`, any of those with `/step`, or a comma list; or
one of `@hourly`, `@daily`, `@weekly`. It is read in the local time of the machine Paseo runs on. A
minute Paseo was not running for is not made up later. A script with no schedule, or one that cannot
be read, is listed on the card as invalid and never run.

It runs in Mission Control's home with these in its environment:

| Variable | What it holds |
| --- | --- |
| `MISSION_CONTROL_HOME` | Mission Control's home. |
| `MISSION_CONTROL_BACKLOG` | The backlog, `state/backlog.md`. |
| `MISSION_CONTROL_WATCH_NAME` | The script's file name. |
| `MISSION_CONTROL_WATCH_STATE` | A directory of its own, kept between runs, to remember what it last saw. |

## What it prints

Everything a run prints to stdout reaches Mission Control as one note, however many lines it takes: a
header and a list of findings is the usual shape, and runs that come in while Mission Control is busy
arrive together. Print nothing at all when nothing is new: an empty run costs nothing. Errors go to
stderr, never stdout.

## Be careful with your output

The plugin wraps what a watch prints in `<mission-control-watch>` tags and adds nothing else, so all of it
reaches Mission Control as the script's own words — and the script is yours, so its words carry your
instructions.

- A script that relays text from elsewhere — pull request comments, issue bodies, web pages, logs —
  must mark that text clearly as quoted, written by someone else, and information only, or Mission
  Control cannot tell it from you.
- It should also say what Mission Control is to do with its findings.

`pr-watch` shows the shape: its changes, the quotes in them marked, and a closing passage saying whose
words those are and what to do.

## Limits

- A run has two minutes; stdout past 16,000 characters is cut.
- Runs that wait while Mission Control is busy arrive together in one message of at most 32,000
  characters. When they would not fit, the oldest are dropped whole — never cut in the middle — and the
  message starts with a count of them; the card shows those watches as dropped. The newest always
  arrives.
- A run that exits non-zero or runs out of time is reported to Mission Control once, with the end of
  its stderr, and not again until a run succeeds.
- A watch still running when it is due again is not started twice.

## Remembering what it saw, and trying one out

Keep what a watch has seen in `MISSION_CONTROL_WATCH_STATE`, and let its first run only record that and print
nothing, so it reports what changes rather than everything there is. To try one, run it by hand from
the home with one scratch state directory, twice: the first run should be silent, the second should
print only what changed in between.

```sh
export MISSION_CONTROL_HOME=$PWD MISSION_CONTROL_BACKLOG=$PWD/state/backlog.md MISSION_CONTROL_WATCH_NAME=my-watch
export MISSION_CONTROL_WATCH_STATE=$(mktemp -d)
./my-watch; ./my-watch
```

## pr-watch

`pr-watch` is Mission Control's own: it reads the backlog for pull request URLs and says when one is merged
or closed, gets a review or comment, or its checks go red or green. Until you edit it, a new version of
the plugin replaces it; once you have, yours is kept, and the card says when the plugin's has changed —
delete the file to take the new one. A deleted built-in comes back, so switch it off on the card
instead.

Mission Control does not add or change watches without your say-so.
