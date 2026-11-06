/**
 * The daemons the crew can run on: this one, and every connected host it has
 * registered (`paseo host add`). Mission Control starts crewmates anywhere with
 * Paseo's own `serverId` tools; this is how the board finds them again.
 *
 * A client per host is opened once and kept, because the board polls every
 * few seconds. A client that fails is dropped and reopened on the next use, so
 * a reconnect or a re-registration is picked up without a reload, and a host
 * that leaves the directory has its client closed.
 */
import type { PaseoApi } from "./host-types";

/** How long one host may take to answer before the board gives up on it for this poll. */
export const HOST_TIMEOUT_MS = 8000;

export interface CrewHost {
  /** Null for this daemon. */
  serverId: string | null;
  /** Null for this daemon. */
  label: string | null;
  api: PaseoApi;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} seconds`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class HostClients {
  private readonly clients = new Map<string, Promise<PaseoApi>>();
  private lastListError: string | null = null;

  /** Every enabled connected host that is online now. Closes clients for hosts that are not. */
  async online(paseo: PaseoApi): Promise<Array<{ serverId: string; label: string }>> {
    let directory: Awaited<ReturnType<PaseoApi["hosts"]["list"]>>;
    try {
      directory = await withTimeout(paseo.hosts.list(), HOST_TIMEOUT_MS, "The host directory");
      this.lastListError = null;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (text !== this.lastListError) console.error("[mission-control] could not list connected hosts:", error);
      this.lastListError = text;
      return [];
    }
    const online = directory.hosts.flatMap((host) =>
      host.enabled && host.status === "online" && host.serverId !== null
        ? [{ serverId: host.serverId, label: host.label ?? host.serverId }]
        : [],
    );
    const live = new Set(online.map((host) => host.serverId));
    for (const serverId of [...this.clients.keys()]) {
      if (!live.has(serverId)) void this.drop(serverId);
    }
    return online;
  }

  /** This daemon first, then every connected host that is online and reachable. */
  async all(paseo: PaseoApi): Promise<CrewHost[]> {
    const local: CrewHost = { serverId: null, label: null, api: paseo };
    const opened = await Promise.all(
      (await this.online(paseo)).map(async (host): Promise<CrewHost | null> => {
        try {
          return { ...host, api: await this.api(paseo, host.serverId) };
        } catch (error) {
          console.error(`[mission-control] could not reach ${host.label}:`, error);
          return null;
        }
      }),
    );
    return [local, ...opened.filter((host): host is CrewHost => host !== null)];
  }

  /** The API for one host; null means this daemon. Refuses a server ID that is not an online connected host. */
  async api(paseo: PaseoApi, serverId: string | null): Promise<PaseoApi> {
    if (serverId === null) return paseo;
    let client = this.clients.get(serverId);
    if (client === undefined) {
      if (!(await this.online(paseo)).some((host) => host.serverId === serverId)) {
        throw new Error(`${serverId} is not an online connected host.`);
      }
      const opening = withTimeout(paseo.hosts.client(serverId), HOST_TIMEOUT_MS, `Host ${serverId}`);
      client = opening;
      this.clients.set(serverId, opening);
      // A failed open is not kept, so the next use tries again.
      opening.catch(() => {
        if (this.clients.get(serverId) === opening) this.clients.delete(serverId);
      });
    }
    return client;
  }

  /** Closes a host's client; with `expected`, only if that is still the cached one. */
  async drop(serverId: string, expected?: PaseoApi): Promise<void> {
    const client = this.clients.get(serverId);
    if (client === undefined) return;
    if (expected !== undefined && (await client.catch(() => null)) !== expected) return;
    if (this.clients.get(serverId) !== client) return;
    this.clients.delete(serverId);
    await client.then((api) => api.dispose()).catch(() => {});
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.clients.keys()].map((serverId) => this.drop(serverId)));
  }
}
