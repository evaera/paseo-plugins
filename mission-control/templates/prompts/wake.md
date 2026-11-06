<!--
When Mission Control wakes on its own, and what it does then. Mission Control keeps one Paseo heartbeat
named "Mission Control wake" on the schedule below, sets it up when it takes over, and changes it when
this file's schedule changes. Every wake it runs its own checks first (the crew, and pull requests
when the PR watch cannot), then the steps here. This file is yours; the plugin never overwrites it.

- schedule: a crontab line (minute, hour, day of month, month, day of week), the same syntax as the
  watches in watches/, or "off" for no wake at all. The default is every 15 minutes from 9:00 to
  17:45, Monday to Friday.
- timezone: the IANA zone the schedule is read in.

Every wake is a turn, so it costs tokens even when nothing has happened. A check a script can make
without a model belongs in a watch (watches/README.md), which costs nothing until it finds something;
this file is for what needs judgment. Mission Control keeps what it needs between wakes, such as the
last message it read in a channel, in state/wake-state.md.
-->

# Wake

schedule: */15 9-17 * * 1-5
timezone: {{timezone}}

## Every wake

- (none yet: add the channels, trackers and dashboards Mission Control should look at)
