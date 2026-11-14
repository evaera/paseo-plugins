/**
 * The open-request mailbox's client half. Another plugin (Mission Control)
 * drops a request file in Debrief's data directory; this claims them every two
 * seconds while responsive, backing off on slow or failed replies. A claim removes
 * the file, so when two apps are connected the first to poll opens it.
 */
import type { PluginClientContext } from "@getpaseo/plugin/client";

import { claimOpenRequests, type OpenRequest } from "../shared/rpc";

const POLL_MS = 2000;
const MAX_POLL_MS = 30_000;

export function startOpenRequestPoller(
  client: Pick<PluginClientContext, "rpc">,
  open: (request: OpenRequest) => void,
): () => void {
  let stopped = false;
  let warned = false;
  let retryMs = POLL_MS;
  let timer: ReturnType<typeof setTimeout>;

  async function poll() {
    if (stopped) return;
    const started = Date.now();
    let delay = POLL_MS;
    try {
      const { requests } = await client.rpc(claimOpenRequests, {});
      if (!stopped) requests.forEach((request) => open(request));
      warned = false;
      retryMs = POLL_MS;
      delay = Math.min(MAX_POLL_MS, Math.max(POLL_MS, (Date.now() - started) * 2));
    } catch (cause) {
      // A daemon mid-reload answers with an error for a moment; say so once, not every 2s.
      if (!warned) console.warn("[debrief] open requests could not be claimed:", cause);
      warned = true;
      delay = retryMs;
      retryMs = Math.min(MAX_POLL_MS, retryMs * 2);
    } finally {
      if (!stopped) timer = setTimeout(() => void poll(), delay);
    }
  }

  timer = setTimeout(() => void poll(), POLL_MS);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
