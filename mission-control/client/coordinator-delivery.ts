import type { CoordinatorDelivery } from "../shared/fleet";

/** Submit once. Lost responses and missing/uncertain receipts only trigger read-only checks. */
export async function waitForCoordinatorDelivery(
  submit: () => Promise<CoordinatorDelivery>,
  read: () => Promise<CoordinatorDelivery>,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  let receipt: CoordinatorDelivery | undefined;
  try { receipt = await submit(); } catch { /* A transport failure is not proof of non-delivery. */ }
  let delay = 1000;
  for (;;) {
    if (receipt?.state === "sent") return;
    if (receipt?.state === "failed") throw new Error(receipt.error ?? "The message could not be prepared for delivery.");
    await pause(delay);
    delay = Math.min(30_000, delay * 2);
    try { receipt = await read(); } catch { /* Keep the pending state through disconnections. */ }
  }
}
