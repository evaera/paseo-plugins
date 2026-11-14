/**
 * Talking to an agent without cutting it off, as far as its provider allows.
 *
 * `PaseoAgentHandle.send` interrupts a running turn by default. For Mission
 * Control that is the wrong thing: it may be halfway through dispatching three
 * crewmates when the user adds a fourth request. The daemon also accepts
 * `activeTurnBehavior: "steer"`: where the provider can take a message in the
 * middle of a turn, the message joins it; where it cannot, the daemon
 * replaces the running turn with one that starts from the message; and an
 * idle agent simply starts a turn. That is exactly how Paseo delivers its own
 * finish notifications to the agent that created a crewmate, so a Mission Control agent
 * is never worse off for a message from the board than for one from Paseo.
 */
import type { PaseoApi } from "./host-types";
import { sendSessionRequest } from "./daemon-session";
import { UnconfirmedDelivery } from "./coordinator-deliveries";

type SendOptions = NonNullable<Parameters<ReturnType<PaseoApi["agents"]["ref"]>["send"]>[1]>;

/**
 * What can go with the words: the send's own `images` and `attachments`, as Paseo's composer fills them,
 * and a `messageId`, which the timeline keeps as the message's `clientMessageId`.
 */
export type SendExtras = Pick<SendOptions, "images" | "attachments" | "messageId">;

export async function sendWithoutInterrupting(
  paseo: PaseoApi,
  agentId: string,
  text: string,
  extras: SendExtras = {},
): Promise<void> {
  await paseo.agents.ref(agentId).send(text, { ...extras, activeTurnBehavior: "steer" });
}

/** The SDK drops acknowledgments after 60s. Keep listening for a late coordinator acknowledgment. */
export async function sendCoordinatorMessage(paseo: PaseoApi, agentId: string, text: string, extras: SendExtras & { messageId: string }): Promise<void> {
  const started = Date.now();
  const fields = { event: "plugin_coordinator_send", agentId, messageId: extras.messageId };
  console.log(JSON.stringify({ ...fields, phase: "start" }));
  try {
    if (process.send === undefined) {
      await sendWithoutInterrupting(paseo, agentId, text, extras);
      console.log(JSON.stringify({ ...fields, phase: "accepted", durationMs: Date.now() - started }));
      return;
    }
    const reply = await sendSessionRequest({ type: "send_agent_message_request", agentId, text,
      ...extras, activeTurnBehavior: "steer" }, "send_agent_message_response", 15 * 60_000);
    if (reply.accepted !== true) throw new Error(typeof reply.error === "string" ? reply.error : "The daemon did not confirm delivery.");
    console.log(JSON.stringify({ ...fields, phase: "accepted", durationMs: Date.now() - started }));
  } catch (error) {
    console.log(JSON.stringify({ ...fields, phase: "unknown", durationMs: Date.now() - started }));
    // Even a rejection can follow provider acceptance. Do not infer non-delivery from an error.
    throw new UnconfirmedDelivery(error instanceof Error ? error.message : String(error));
  }
}
