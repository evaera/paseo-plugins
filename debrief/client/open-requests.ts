/**
 * The open-request mailbox's client half. Another plugin (Mission Control)
 * drops a request file in Debrief's data directory; this claims them every two
 * seconds and opens the panel on the workspace each one names. A claim removes
 * the file, so when two apps are connected the first to poll opens it.
 */
import type { PluginClientContext } from "@getpaseo/plugin/client";

import { claimOpenRequests, type OpenRequest } from "../shared/rpc";

const POLL_MS = 2000;

export function startOpenRequestPoller(
  client: Pick<PluginClientContext, "rpc">,
  open: (request: OpenRequest) => void,
): () => void {
  let inFlight = false;
  let stopped = false;
  let warned = false;

  async function poll() {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      const { requests } = await client.rpc(claimOpenRequests, {});
      if (!stopped) requests.forEach((request) => open(request));
    } catch (cause) {
      // A daemon mid-reload answers with an error for a moment; say so once, not every 2s.
      if (!warned) console.warn("[debrief] open requests could not be claimed:", cause);
      warned = true;
    } finally {
      inFlight = false;
    }
  }

  const timer = setInterval(() => void poll(), POLL_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
