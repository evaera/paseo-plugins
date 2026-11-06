# paseo-plugins

Two plugins for [Paseo](https://paseo.sh).

| Plugin | What it does |
| --- | --- |
| [`debrief/`](debrief) | Review an agent's changes in a workspace tab: a from-vs-to diff in a real editor with go-to-definition, inline comments the agent answers live, stories, and plan review. Replaces Crit. |
| [`mission-control/`](mission-control) | Talk to one Mission Control agent that runs a crew of agents in their own worktrees, with a live board of the crew. |

Install either from this repository on a daemon with plugins enabled (`"pluginsEnabled": true` in
`~/.paseo/config.json`):

```bash
paseo plugin add git:evaera/paseo-plugins:mission-control
paseo plugin add git:evaera/paseo-plugins:debrief
```

Debrief needs Paseo 0.14 or newer; Mission Control 0.13. Each plugin's README covers setup, and
`AGENTS.md` covers working on them: each folder is its own npm project.

## License

MIT, copyright eryn L. K. See `LICENSE`, and `ATTRIBUTIONS.md` for the projects this one builds on.
