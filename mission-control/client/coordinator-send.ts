/**
 * Sending the user's words to Mission Control. The chat's Send, Status
 * and Catch up, and a suggestion's button all go through here, so they share one
 * message in flight at a time per Mission Control, and a failure is reported the
 * same way whichever sent it. What Mission Control does with a message that
 * arrives mid-turn is the daemon's (`server/send.ts`); what the user sees
 * go out is the transcript, which echoes the message like any other.
 *
 * The gate is in module scope, not component state, so it is shared by the
 * chat and the surface, and a phone switching tabs mid-send — which unmounts
 * the chat — cannot send a second message behind the first.
 */
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useSyncExternalStore } from "react";

import { newCoordinatorMessageId, type UserMessage } from "../shared/attachments";
import { askCoordinator, askCoordinatorCommand, coordinatorDelivery, type CoordinatorCommand, type CoordinatorDelivery } from "../shared/fleet";
import { errorText } from "./format";
import { waitForCoordinatorDelivery } from "./coordinator-delivery";

/** One task at a time; a second started while the first runs is refused. */
export interface SendGate {
  busy(): boolean;
  subscribe(listener: () => void): () => void;
  /** Starts `task` and resolves as it does, or returns null without starting it while another runs. */
  run<T>(task: () => Promise<T>): Promise<T> | null;
}

export function createSendGate(): SendGate {
  let running = false;
  const listeners = new Set<() => void>();
  function set(next: boolean): void {
    running = next;
    listeners.forEach((listener) => listener());
  }
  return {
    busy: () => running,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    run<T>(task: () => Promise<T>): Promise<T> | null {
      if (running) return null;
      set(true);
      let started: Promise<T>;
      try {
        started = task();
      } catch (error) {
        // A task that throws before it has a promise must not leave the gate shut.
        started = Promise.reject(error);
      }
      return started.finally(() => set(false));
    },
  };
}

interface CoordinatorGate extends SendGate { read?: (messageId: string) => Promise<CoordinatorDelivery> }
// Survive a host reconnect, like the draft store. The next hook lends the current RPC connection.
const SLOT = Symbol.for("paseo.mission-control.sends");
const gates: Map<string, CoordinatorGate> = Reflect.get(globalThis, SLOT) ?? new Map();
Reflect.set(globalThis, SLOT, gates);

function gateFor(coordinatorId: string): CoordinatorGate {
  let gate = gates.get(coordinatorId);
  if (gate === undefined) {
    gate = createSendGate();
    gates.set(coordinatorId, gate);
  }
  return gate;
}

export interface CoordinatorSender {
  /** A message to Mission Control is on its way. */
  sending: boolean;
  /**
   * Sends a message, unless one is already on its way; false when refused. A
   * failure is shown as a toast, then `onFailure` runs — the chat's Send puts
   * its text back there. `onSent` runs once the daemon has taken it, for a
   * caller with no transcript in view to show it.
   */
  send: (message: UserMessage, onFailure?: () => void, onSent?: () => void) => boolean;
  /** Status or Catch up, worded on the daemon; refused and reported like `send`. */
  command: (command: CoordinatorCommand) => boolean;
}

export function useCoordinatorSender(coordinatorId: string): CoordinatorSender {
  const ask = useRpc(askCoordinator);
  const askCommand = useRpc(askCoordinatorCommand);
  const read = useRpc(coordinatorDelivery);
  const toast = useToast();
  const gate = gateFor(coordinatorId);
  gate.read = (messageId) => read({ messageId });
  const sending = useSyncExternalStore(gate.subscribe, gate.busy);

  function deliver(task: () => Promise<unknown>, onFailure?: () => void, onSent?: () => void): boolean {
    const started = gate.run(task);
    if (started === null) return false;
    started.then(
      () => onSent?.(),
      (caught: unknown) => {
        toast.error(errorText(caught));
        onFailure?.();
      },
    );
    return true;
  }

  return {
    sending,
    send: (message, onFailure, onSent) => {
      const messageId = newCoordinatorMessageId((message.images?.length ?? 0) > 0);
      return deliver(() => waitForCoordinatorDelivery(() => ask({ ...message, messageId }), () => gate.read!(messageId)), onFailure, onSent);
    },
    command: (command) => {
      const messageId = newCoordinatorMessageId();
      return deliver(() => waitForCoordinatorDelivery(() => askCommand({ command, args: "", messageId }), () => gate.read!(messageId)));
    },
  };
}
