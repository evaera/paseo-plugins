import { getPaseoClient, useHosts, usePaseo } from "@getpaseo/plugin/client";
import { useCallback } from "react";

type PaseoApi = ReturnType<typeof usePaseo>;

/**
 * How to reach the host an agent runs on: the board's own host for null,
 * otherwise the app's connection to that connected host. `acquire` is called
 * when the API is used, never cached, because the app releases an API when its
 * connection changes; `hostKey` changes with that host's connection, so an
 * effect that depends on it subscribes again. `acquire` throws when the app
 * has no connection to the host.
 */
export function useHostPaseo(serverId: string | null): { acquire: () => PaseoApi; hostKey: string } {
  const selected = usePaseo();
  const host = useHosts().find((entry) => entry.serverId === serverId);
  const hostKey = serverId === null ? "local" : host === undefined ? "unknown" : `${host.status}`;
  const acquire = useCallback((): PaseoApi => (serverId === null ? selected : getPaseoClient(serverId)), [selected, serverId]);
  return { acquire, hostKey };
}
