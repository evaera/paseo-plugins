/**
 * Paseo's types, taken from the one package the host actually provides.
 *
 * A running plugin is given `@getpaseo/plugin`, not `@getpaseo/client` or
 * `@getpaseo/protocol`: those are devDependencies, and an npm install runs
 * `--omit=dev`. The daemon resolves every import reachable from an entry, type
 * imports included, so every Paseo type Debrief needs is projected out of
 * `@getpaseo/plugin` here. `server/host-imports.test.ts` fails if anything
 * reaches for the upstream packages instead.
 */
import type { PluginHandlerContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";

export type PaseoApi = PluginHandlerContext["paseo"];

export type PaseoAgent = Awaited<ReturnType<PaseoApi["agents"]["list"]>>["entries"][number]["agent"];

export type AgentListOptions = NonNullable<Parameters<PaseoApi["agents"]["list"]>[0]>;

export type SendOptions = NonNullable<Parameters<ReturnType<PaseoApi["agents"]["ref"]>["send"]>[1]>;

export type TimelineAppendItem = Parameters<ReturnType<PaseoApi["agents"]["ref"]>["timeline"]["append"]>[0];

export type PermissionRequest = PluginLifecycleEvents["agent.permission_requested"]["request"];

/** A plugin timeline row's `data`: JSON, with no `undefined` anywhere. */
export type TimelineData = TimelineAppendItem["data"];
