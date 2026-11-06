# AGENTS.md

[Paseo](https://paseo.sh) plugins, one self-contained folder per plugin: `debrief/` and
`mission-control/`. Plugin code is trusted and unsandboxed: the server half runs next to the
daemon with its files, processes and credentials; the client half runs inside the Paseo app.

Mission Control has its own `mission-control/AGENTS.md`; Debrief's notes are the `debrief` section
below. This file is only what they share. References below to `skills/`, `github-board/`, `launchd-jobs/`, `herald/` or
`model-pricing/` are worked examples from the project these plugins started from (see
`ATTRIBUTIONS.md`), not folders here.

## There is no workspace root

Each folder is an independent npm project with its own `package.json`, `node_modules`,
`tsconfig.json`, and `paseo-plugin.json`. Nothing is hoisted, and there is no root `package.json`.
Every command below runs from inside a plugin folder, never from the repo root.

`paseo plugin install` records the absolute directory it was given and the daemon loads from that
path on every start, so moving this clone means reinstalling every plugin in it.

```bash
cd debrief         # or mission-control
npm install
npm run typecheck
npm test
npm test -- server/diff.test.ts      # one file
npm test -- -t "re-anchors"          # one test by name
```

## Dev loop against a running daemon

```bash
paseo plugin reload debrief       # after any source change; the id, not the folder name
paseo plugin logs debrief         # load errors and stderr
```

- The plugin ids are `debrief` and `mission-control`.
- **A failed reload stays failed.** Paseo does not restore the previous code.
- **Never restart the daemon**: it manages the user's running agents.
- The daemon needs `"pluginsEnabled": true` in its `config.json`. Debrief needs Paseo **0.14.0** or
  newer (agent tools), Mission Control 0.13.0. On an older daemon a plugin refuses to load.
- There is no harness for plugin UI. A clean typecheck and a clean reload prove a `client/` change
  compiles and loads, nothing more. Look at it: on desktop, or by driving `https://app.paseo.sh`
  in Paseo's own browser tab with the browser tools, which reaches the same daemon. Check a wide
  window and a compact one, and switch theme.

## Plugin architecture

Every plugin is the same shape. Each has up to two entries, one per runtime, and at least one is
required. Both are wiring only, they bind RPC contracts to handlers and register contributions,
and return a cleanup function:

```ts
// index.server.ts, runs in a daemon subprocess
export default function contribute(server: PluginServerContext) {
  server.handle(loadBoard, loadBoardHandler);
  server.registerSettings(displaySettings);
  return () => {};
}
```

```tsx
// index.client.tsx, runs inside the Paseo app, once per connected client
export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "board", ... });             // github-board: global screen
  client.addWorkspacePanel({ context: "agent", ... }); // skills: per-agent workspace tab
  client.addSettingsScreen({ ... });
  client.addCommandCenterItem({ ... });
  return () => {};
}
```

A top-level React call or `StyleSheet.create` in `index.server.ts` executes in the daemon bundle.
Keep it out.

**Directories decide which bundle code lands in**, and crossing the boundary fails compilation.
Filename suffixes mean nothing, and a code module at the plugin root is a compile error, only
`paseo-plugin.json`, `package.json`, `tsconfig.json` and the two entries live there.

| Directory | Owns |
| --- | --- |
| `client/` | React and UI. May import only the host-provided modules: `react`, `react-native`, `@tanstack/react-query`, `zod`, `@getpaseo/plugin`, `@getpaseo/plugin/client`, `@getpaseo/plugin/client/react-native`, `@getpaseo/plugin/client/ui`. |
| `server/` | Node built-ins, filesystem, subprocesses, RPC handlers. |
| `shared/` | zod RPC contracts (`defineRpc`), settings documents (`defineSettings`), and plain values imported by both halves. No Node, no React. |

Client and server never share a process. Every crossing is a `defineRpc` contract in `shared/`,
called from the client with `useRpc(contract)` and answered by `server.handle`. Handlers receive a
`PluginHandlerContext` carrying `paseo`, the host API, that is how `skills/server/skills.ts`
resolves an `agentId` to its provider and cwd.

### Which side owns a persisted value

Two stores, and the rule is which side has to *write* it:

- **A settings document** (`defineSettings` in `shared/`, `server.registerSettings` in the server
  entry, `useSettings` in a component) is host-scoped storage the **client** reads and writes. The
  server can read one, `registerSettings` returns a handle with `read()` and `subscribe()`, but
  it cannot write one, so a value the daemon has to change stays out of it.
- **The plugin's own file** under `$PASEO_HOME/plugin-data/<id>/` is whatever the **daemon** needs.
  It costs an RPC per read and write, which is the price of the handler being able to write the value.

**Never keep data under `$PASEO_HOME/plugins/<id>/`.** That is Paseo's install root for an npm or
Git install, the version directories live there, and `paseo plugin remove` deletes it whole.
Paseo never touches `plugin-data/`; each plugin's `server/data-dir.ts` names its directory there.

`github-board` splits exactly on that line: the repository filter, the prompt templates and the
detail panel's width are drawn and nothing else, so they are settings documents; the `gh` login and
the launch defaults are what handlers run on and save, so they stay in the daemon's file. The
server-side `read()` arrived with the 0.9 SDK, after that split was made; nothing here uses it yet.

### Constraints nothing catches at compile time

- **A closure inside a `for (let|const … of …)` body captures the loop's final value on
  iOS/Android** (`client/`, `shared/`). The app `eval`s the client bundle, and Hermes's eval
  compiler does not give each iteration its own binding, reach for `.map` when a callback must
  capture the element. Desktop runs the web export on V8 and does not show it, so a working desktop
  surface proves nothing about mobile. Async **arrows** used to fail the same way, Hermes evaluated
  one to `undefined`, and the surface died with "Plugin failed: undefined is not a function", but
  since Paseo 0.7.0 the daemon compiles client bundles with esbuild's `async-await` support off,
  so every async function is lowered before the app sees it, and nothing here loads on an older
  daemon. The loop is not lowered, the client target is `es2020`, which has block scoping, so
  that rule stands.
- **RPC wire names must match `/^[a-z][a-z0-9._-]*$/`.** camelCase names load-fail with "Invalid
  plugin RPC method" and the plugin never starts. Use Paseo's dotted namespacing: `board.load`,
  `skills.list`. The exported identifier is unrelated to the wire name.
- **Colour comes from `theme.colors`, never a literal.** The tokens are `surface0`, `surface1`,
  `surface2`, `foreground`, `foregroundMuted`, `border`, `accent`, `accentForeground`,
  `statusSuccess`, `statusWarning`, `statusDanger`. Any other name renders as undefined at runtime.
- **`icon` is any Lucide component name**, typed as a bare `string`. The host resolves it with
  `Reflect.get` over the Lucide barrel and throws `Unknown Lucide icon: <name>` at contribution
  time, so a typo load-fails the plugin. Brand icons are in there too, `Github`.
- **Relative imports are extensionless**, `./frontmatter`, not `./frontmatter.js`.
- **Browser globals live only in `client/web.ts`.** No `tsconfig` here has `"DOM"` in `lib`, so
  `document` and `window` are type errors everywhere by default. That one module declares the narrow
  shape of each global it uses, gates every export on `Platform.OS`, and gives native the
  alternative or a no-op, see `github-board/client/web.ts`, which owns the document-level pointer
  tracking the detail panel's resize handle needs on web.
- **Opening a URL is not one of those globals any more.** `openExternalUrl` from
  `@getpaseo/plugin/client` reaches the same platform opener Paseo's own links go through, on every
  platform. It used to be hand-rolled in two copies of `client/web.ts`, because `Linking.openURL` is
  `window.open` on the desktop renderer and lands in a bare child window; both are gone. It answers
  with a promise, so a press handler `void`s it rather than awaiting it. The
  in-app alternative is `navigation.openBrowser`, which opens a tab *inside* a workspace and is
  **Electron-only**: the host leaves it `undefined` on web, iOS and Android and does not fall back,
  so anything drawn for it has to disappear there. It takes a `workspaceId` and is the one piece of
  navigation a timeline item cannot reach, `PluginTimelineItemProps` carries no `navigation` at
  all, unlike surfaces and panels.
- **Plugin Command Center items rank below Paseo's own actions, and a keyword-only match ranks
  below a visible one.** The host hardcodes their group rank to 5, after its own action groups, and
  that is all that orders them with an empty query. With a query, action sections, plugin ones
  included, reorder by match score, and a row that matched only a hidden keyword scores below any
  row whose title matched. Workspaces, agents and files sit in a band pinned *below* every action
  section, so a filename never outranks a plugin item.
- **A surface is unmounted when the user navigates away**, to a workspace, an agent, anywhere , 
  and mounted fresh on the way back, so component state is gone. Anything that should survive the
  round trip and is *not* worth persisting (a loaded board, the open pane, a half-typed form) lives
  in module-scope variables the component reads on mount: `cachedBoard` in `github-board`,
  `cachedPane` and `cachedDraft` in `launchd-jobs`. Anything that *is* worth persisting belongs in a
  settings document, which the host restores on its own. Since 0.11 a screen has a third place:
  its **params**, string pairs that travel in the screen's URL, so they survive a reload, back and
  forward, and a saved link. **A screen is handed its params once, on arrival, and nothing changes
  them.** `openScreen` is a `router.push` onto a route with no `getId`, so every call mounts a *new*
  screen, even to the one already showing, and leaves the old one mounted and running underneath.
  Read params on mount, and never call `openScreen` from inside a screen to record what it shows:
  `launchd-jobs` and `github-board/client/screen.ts` take a job and a card on arrival only.
- **Draw with `addScreen`, `addSidebarHeaderItem` or `addSidebarFooterItem`, and `openScreen`.**
  `addSurface`, `addSidebarItem` and `openSurface` are 0.11's deprecated aliases for them, due to be
  removed after 2027-03-29. A screen carries its own header title, a string or a function of its
  params, and a sidebar item is a live component drawn from the host being viewed, where a legacy
  row took the first host's title. Moving a plugin over, **register the screen and a header item
  under the old sidebar item's id**: the app resolves a saved `/sidebar/<id>` link to the screen
  with that id, and a header item with that id keeps the row's place and hidden state in
  Settings → Sidebar, a footer item is keyed apart from the old row, so it starts fresh. A
  sidebar item's and a popover's props carry `openScreen` but neither `navigation` nor
  `openSettings`.
- **Module scope does not outlive the host's connection.** When the connection to a host drops, the
  phone backgrounded, the Mac asleep, a network change, the app disposes that host's plugins, and it
  evaluates the bundle afresh when the connection returns, so every module-scope variable starts over.
  The bundle is evaluated with an indirect `eval` in the app's global scope, so a slot on `globalThis`
  under a `Symbol.for` key is still there for the new evaluation: `mission-control/client/draft.ts` keeps the
  chat's unsent message that way, for the life of the app.
- **`paseo.agents.subscribe()` alone hears nothing.** Since 0.9 it is a local listener fed only by
  an observation the same API instance opened with `agents.list({ subscribe: {} })`, and the app's
  own observations do not reach it. Since 0.11 the app gives each installed plugin **one**
  `PaseoApi`, shared by the client entry (`client.paseo`), `usePaseo()` in every screen, panel and
  timeline item, and every Command Center and slash-command callback, and disposes it only when the
  plugin is torn down. So a bare `subscribe()` hears whatever the plugin's other observations
  feed, and nothing until one is open; and an observation that is never released lasts until the
  plugin unloads, not until the component that opened it unmounts. Open one and release it on
  teardown; a snapshot is one page (`pageInfo.hasMore`), not the whole list. See
  `skills/client/agents.ts` and `herald/client/agents.ts`.
- **The server half is given `paseo` only inside an RPC handler or a lifecycle hook.**
  `PluginServerContext` has none, so a timer started in the server entry cannot reach Paseo on its own.
  Every handler and hook receives the same object, though, the plugin process creates one `PaseoApi`
  and hands it to all of them, so keeping the first one seen is sound; until something calls in after
  a start, the timer has to wait. See `mission-control/server/watch-service.ts`.
- **Paseo's `<paseo-system>` notes never reach a timeline.** The daemon drops a user message that is a
  whole `<paseo-system>` envelope, a finish note, a schedule fire, a chat mention, before recording
  it, so a hook's `timeline`, a timeline fetch and `paseo logs` all omit it, though the provider's own
  session has it. Code that reacts to one has to go by what caused it; see `mission-control/server/crew-seen.ts`.
- **`useWorkspace` and `useAgent` work only inside workspace panels.** Called from a sidebar surface
  they throw "Plugin state hooks must run inside a workspace panel" on mount, and the surface renders
  that error instead of itself. A surface reads workspaces and agents through `usePaseo()`, see
  `herald/client/herald.tsx`, which maps workspace ids to titles from `workspaces.list()`.
- **`SettingsSelect`'s popover does not scroll.** It works for a handful of options and cannot be
  used for a long list, a Mac lists 185 `say` voices. Past about ten options, open a host `Modal`
  with `scrollable={false}` and put the host `FlatList` and a search `TextInput` inside it, see
  `herald/client/option-picker.tsx`.
- **A plugin cannot open a file or photo picker on iOS or Android.** Paseo's app picks with Expo's
  image and document pickers, and neither is a host module; `react-native` itself has none, and the
  host's `TextInput` does not hand over pasted images. On the web renderer, desktop and browsers,
  phone browsers included, `client/web.ts` can create an `<input type="file">` and listen for paste
  and drop on a view's element. Nor is Paseo's composer embeddable: composer pills and attachment
  sources feed Paseo's own. `mission-control/AGENTS.md` records what the chat built instead, and the shapes
  Paseo sends images and files in.
- **Another host is reachable from the client, but only as Paseo.** `useHosts()` lists every host the
  app is configured with, and `getPaseoClient(serverId)` borrows the app's own connection to one as
  an ordinary `PaseoApi`, projects, workspaces, agents, providers, terminals, whether or not the
  plugin is installed there. It is **not** plugin RPC: `useRpc` and `client.rpc` still reach only
  the plugin's own daemon, and server handlers have no equivalent at all. Nor can it add a plugin
  timeline row: the daemon accepts `type: "plugin"` appends only from that plugin's own session.
  Borrow it per action, inside an async function, it throws for a host that is offline or whose
  connection was replaced, and pass the same `serverId` to `navigation.openAgent`,
  `openWorkspace` or `openBrowser` to follow the work across. `github-board`'s send dialog is the
  worked example.
- **A surface cannot open its own settings screen.** `PluginScreenProps` carries no
  `openSettings`, and nor do the sidebar item's and popover's props; only `PluginClientContext`
  and a Command Center or slash-command callback have it.
  A surface that needs to reach one keeps its own in-surface editor, routes the user through ⌘K , 
  see `github-board`, which does both, or is *lent* the capability by the entry:
  `herald/index.client.tsx` passes `client.openSettings` to a module-scope binding in
  `herald/client/herald.tsx`, which its header gear calls. Contribution runs before any surface
  mounts, so the binding is always set by the time one renders; it is cleared in the cleanup.

### Versions

`paseo-plugin.json` carries `requirements.paseo`, an npm semver range. **A missing
`requirements.paseo` means `<0.8.0`**, so 0.8 rejects the plugin outright with a link to the
migration guide, adding the field is part of migrating, not a substitute for it. A plugin here
declares `>=0.11.0` once it draws with 0.11's screen and sidebar API, and `>=0.9.0` until then.

**The manifest may only carry what the *oldest* declared version accepts.** `PluginManifestSchema`
is `.strict()` in every Paseo before 0.11.0, so a key one version added is a load failure on every
version before it, not a warning, not an ignored field. 0.11.0 ignores unknown top-level keys
(though `requirements` stays strict) and adds `name`, `icon` and `media`, which 0.10 and older still
reject. 0.9 added `description`, which the app shows in its plugins list; adding it here while
`requirements.paseo` still said `>=0.8.0` broke all five on 0.8, and paseo.cafe's admission scan is
what caught it, because it allows the key for an npm source (0.9-only by construction) and rejects
it for a Git one. Either the key goes or the floor rises, the key went first, and the floor rose
later, when `openExternalUrl` and `navigation.openBrowser` made 0.9 worth requiring; `description`
came back in the same change. Check a new manifest key against the tag named in `requirements.paseo`
before adding it.

The daemon checks the range before installing or loading, and **each connected app checks it against
its own version** before evaluating client code. That second check is what retired this repo's
version-sniffing fallbacks: a client old enough to lack `props.navigation` is a client too old to
evaluate the bundle at all, so the prop is always there in practice even though it is typed
optional.

### Installs and dependencies

Users install from Git: `paseo plugin add git:evaera/paseo-plugins:<plugin>`, optionally with
`--ref <plugin>/v<version>`. A Git install runs nothing but the manifest's `build` commands, so
devDependencies are never on disk there: everything the host provides stays a devDependency, and
only code the daemon must bundle into the client (Debrief's CodeMirror, `diff` and
`@getpaseo/highlight`) is a real `dependency`. Debrief's manifest runs `npm ci --omit=dev
--ignore-scripts` for those, so its `package-lock.json` must stay in sync with `package.json`;
Mission Control has no runtime dependencies and no `build`. A development install from a directory
uses whatever `npm install` put in the folder.

Each manifest carries `name` and `icon` (`assets/icon.png`, rendered from `assets/icon.svg`), and
`assets/` is in `files`. A release is a version in `package.json` (and the lock), a matching
`## [x.y.z]` in the plugin's `CHANGELOG.md`, and a `<plugin>/v<x.y.z>` tag.

Before tagging, install the commit from Git on a throwaway daemon home, never the real one:

```bash
mkdir -p /tmp/paseo-check
printf '%s' '{"version":1,"daemon":{"listen":"127.0.0.1:6799"},"pluginsEnabled":true}' > /tmp/paseo-check/config.json
paseo daemon run --home /tmp/paseo-check &
paseo plugin install "file://$PWD" --path debrief --home /tmp/paseo-check
paseo plugin ls --home /tmp/paseo-check        # want: running, no error
```

There is no build step. Paseo compiles the TypeScript itself.

**Reachable code may import only what the host provides, and neither `@getpaseo/client` nor
`@getpaseo/protocol` is on that list.** The daemon's runtime-boundary plugin resolves every import
reachable from an entry, type imports included, and fails the load when one is missing (`Could not
resolve type dependency`). When reachable code needs a Paseo type, project it out of
`@getpaseo/plugin`, which re-declares them structurally, as each plugin's `server/host-types.ts`
does. `server/sdk-types.ts` imports `@getpaseo/client` on purpose and is fine only because nothing
imports it. `server/host-imports.test.ts` is the guard, duplicated in each plugin: it walks the
graph from the entry points and fails on any crossing that is not host-injected, a Node builtin,
or a real runtime `dependency`.

### The SDK dependency

Both plugins depend on the real published `@getpaseo/plugin`, pinned to an exact version , 
`0.11.0` for a plugin on 0.11's screen and sidebar API, `0.9.0` for the rest, at the time of
writing. Pin it *exactly*: `npm install --save-dev` writes a caret, and a range here is the same bet
on an unreleased shape that the prerelease trap below describes. `skills` used to ship a
hand-written `paseo-plugin.d.ts` shim instead; it was deleted in the 0.8 migration, because every
new host API had to be hand-declared into it before it could be used.

`@getpaseo/plugin` peer-depends on the *exact* `@getpaseo/client` and `@getpaseo/protocol` it ships
against, so all three move together: `npm install @getpaseo/plugin@<v> @getpaseo/client@<v>
@getpaseo/protocol@<v>` in one command. Bumping one alone fails `ERESOLVE`.

**Re-pin only when a plugin needs a newer API, never to track the daemon.** The pins stay where
they are until a plugin needs something only a newer SDK provides; then all three move, exactly, to
the release that provides it, and that plugin's `requirements.paseo` in `paseo-plugin.json` rises to
match if the new API needs that daemon. A new Paseo release alone is not a reason to re-pin: it
buys nothing, and raising the floor with it restricts the plugins to a Paseo version for no reason.

**A prerelease of the SDK is not the release, and nothing tells you when it stops matching.** The
semver range in `paseo-plugin.json` is satisfied either way, the daemon loads the plugin, and
`tsc` type-checks happily against whatever shape the pinned types happen to declare, so a
contribution the shipped app has since redefined compiles clean and is rejected at runtime, in the
app, where no log here shows it. `skills` sat on `0.8.0-beta.1` past the 0.8.0 release and lost its
composer pill exactly that way. Pin a release, never a prerelease, and once the release of a
prerelease you are on ships, move to it.

Because `skipLibCheck: true` is set everywhere, an unresolvable `@getpaseo/client` import is
swallowed silently and the entire Paseo API types as `any`, and `tsc` still exits 0, so a clean
typecheck does not prove the types resolved. **`server/sdk-types.ts` in each plugin is that check**,
standing where a throwaway file used to: it reads a nonexistent member off a `PaseoAgentHandle`
under a `@ts-expect-error`, so it fails in both directions, the access errors while the types are
real, and the directive itself reports TS2578 the moment they degrade to `any`. It is `import
type`-only and lands in no bundle. Do not delete it, and do not "fix" it by removing the directive.

`noImplicitAny` catches part of the same failure, but only where our own code destructures an SDK
value; a handler that just passes `paseo` through type-checks as happily against `any`. The usual
cause is a stale `node_modules`, the lockfiles pin the right version, so `npm install` in the
plugin folder is the fix.

Every `tsconfig.json` now includes `**/*.ts` and `**/*.tsx`; a `client/`, `server/` or `shared/`
subdirectory invisible to `tsc` is the failure mode that made that necessary.

## debrief

A Paseo-native replacement for Crit: a workspace tab (in the "+" menu) that reviews the
workspace's changes as an explicit "from vs to" compare, with a CodeMirror 6 editor (Paseo's code
font and syntax colours, real language servers for go-to-definition, hover and completion),
inline comment threads delivered live to the agent as Paseo agent-messages, agent tools to reply
and comment, stories (chapters plus narration placed in the code) and Plannotator-style plan
review that answers Claude's `ExitPlanMode`.

Two departures from the rules above, both deliberate:

- **CodeMirror, `diff` and `@getpaseo/highlight` are real `dependencies`.** The daemon bundles every
  `node_modules` import into the client bundle (only the host modules stay external), and an npm
  install omits devDependencies. `@codemirror/language` is pinned to the version
  `@getpaseo/highlight` uses so the bundle carries one copy.
- **`cm.ts` `require`s the CommonJS builds**, so anything that builds CodeMirror objects must use
  the modules `cm.ts` loaded; a highlight style built from the ESM copies matches no tags. That is
  why `client/editor/syntax.ts` takes only colour data from `@getpaseo/highlight`.

The editor's mount node carries `data-pmono`: Paseo points every element at its UI font unless it
sits inside a `[data-pmono]` subtree.

## mission-control

Talk to one "Mission Control" agent and it runs a crew of worker agents, each in its own Paseo worktree; a
screen puts the conversation beside a board of the crew. A Paseo-native port of the
[firstmate](https://github.com/kunchenguid/firstmate) agent distro, replacing
ABorakati's `paseo-firstmate`, which was a dashboard over that distro's bash scripts and tmux sessions.
Three things shape it, all in `mission-control/AGENTS.md`: **the plugin never dispatches a crewmate**, Mission
Control does, with Paseo's own MCP tools, following a charter (`templates/data/charter.md`) written into its
home as `AGENTS.md`; **supervision is Paseo's**, the MCP `create_agent` call's `notifyOnFinish` wakes
Mission Control when a crewmate finishes, errors or asks for permission, so there is no watcher, and those
tools are off by default in Paseo (`daemon.mcp.injectIntoAgents`), which the board offers to turn on;
and **the crew is found by label**, `pmc.role=crew`, which the charter and the board read from the
same constant.
