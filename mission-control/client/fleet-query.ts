/** Fleet recovery is shared by the screen, panels and sidebar, including remounts. */
import { queryOptions } from "@tanstack/react-query";
import { staleFleet, type Fleet } from "../shared/fleet";

export const FLEET_QUERY_KEY = ["mission-control", "fleet"] as const;
export const STALE_FLEET_MESSAGE = "Showing the last loaded crew. Retrying the refresh automatically.";

export function fleetWaitMessage(failures: number): string {
  return failures === 0
    ? "Waiting for Paseo to load the crew..."
    : `Paseo could not load the crew. Retrying automatically (attempt ${failures + 1}).`;
}

export function createFleetQuery() {
  let cached: Fleet | null = null;
  return (load: () => Promise<Fleet>, pollSeconds: number) => queryOptions({
    queryKey: FLEET_QUERY_KEY,
    queryFn: async ({ signal, client }) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: () => void = () => {};
      const waiting = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Paseo has not answered the crew request yet.")), 30_000);
        abort = () => reject(new Error("Crew refresh canceled."));
        signal.addEventListener("abort", abort, { once: true });
      });
      try {
        const fleet = await Promise.race([load(), waiting]);
        if (!signal.aborted) cached = fleet;
        return fleet;
      } catch (error) {
        const previous = client?.getQueryData<Fleet>(FLEET_QUERY_KEY) ?? cached;
        if (signal.aborted || previous === null) throw error;
        return (cached = staleFleet(previous, error));
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    },
    retry: true,
    retryDelay: (attempt) => Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)),
    refetchInterval: (query) => Math.max(query.state.data?.stale ? 10_000 : 0, pollSeconds * 1000),
    ...(cached === null ? {} : { placeholderData: cached }),
  });
}
