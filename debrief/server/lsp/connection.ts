/**
 * One language server process and the JSON-RPC conversation with it.
 *
 * Requests time out after ten seconds. Requests from the server get the
 * minimal answers a real editor would give (`workspace/configuration` gets a
 * null per item, capability registration and progress creation get null), and
 * `textDocument/publishDiagnostics` is kept per URI for `lspDiagnostics`.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { encodeMessage, MessageReader } from "./framing";
import type { ServerCommand } from "./discover";

const REQUEST_TIMEOUT_MS = 10_000;

export interface LspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number;
  message: string;
  source?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type Message = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
};

export class LspConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly reader = new MessageReader();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private exited = false;
  readonly diagnostics = new Map<string, LspDiagnostic[]>();
  private stderrTail = "";

  constructor(
    command: ServerCommand,
    cwd: string,
    env: NodeJS.ProcessEnv,
    private readonly onExit: (code: number | null, stderr: string) => void,
  ) {
    this.child = spawn(command.command, command.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk: Buffer) => {
      for (const message of this.reader.push(chunk)) this.dispatch(message as Message);
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-2000);
    });
    this.child.stdin.on("error", () => {});
    this.child.on("error", (error) => this.finish(null, error.message));
    this.child.on("exit", (code) => this.finish(code, this.stderrTail));
  }

  get alive(): boolean {
    return !this.exited;
  }

  private finish(code: number | null, stderr: string): void {
    if (this.exited) return;
    this.exited = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`The language server exited${stderr.trim() === "" ? "." : `: ${stderr.trim().slice(-300)}`}`));
    }
    this.pending.clear();
    this.onExit(code, stderr);
  }

  private write(message: unknown): void {
    if (this.exited) return;
    this.child.stdin.write(encodeMessage(message));
  }

  private dispatch(message: Message): void {
    if (message.method !== undefined) {
      if (message.id !== undefined) this.write({ jsonrpc: "2.0", id: message.id, result: answerServerRequest(message.method, message.params) });
      else if (message.method === "textDocument/publishDiagnostics") this.storeDiagnostics(message.params);
      return;
    }
    if (typeof message.id !== "number") return;
    const entry = this.pending.get(message.id);
    if (entry === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error !== undefined) entry.reject(new Error(message.error.message ?? "The language server returned an error."));
    else entry.resolve(message.result ?? null);
  }

  private storeDiagnostics(params: unknown): void {
    const value = params as { uri?: unknown; diagnostics?: unknown } | null;
    if (value === null || typeof value.uri !== "string" || !Array.isArray(value.diagnostics)) return;
    this.diagnostics.set(value.uri, value.diagnostics as LspDiagnostic[]);
  }

  request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error("The language server is not running."));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.write({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } });
        reject(new Error(`The language server did not answer ${method} in time.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** `shutdown` then `exit`, and a kill if it lingers. */
  async stop(): Promise<void> {
    if (this.exited) return;
    try {
      await this.request("shutdown", null, 2_000);
    } catch {
      // Stopping anyway.
    }
    this.notify("exit", null);
    const child = this.child;
    setTimeout(() => {
      if (!this.exited) child.kill("SIGKILL");
    }, 2_000).unref();
  }
}

/** What Debrief answers a request the server sends it. */
export function answerServerRequest(method: string, params: unknown): unknown {
  if (method === "workspace/configuration") {
    const items = (params as { items?: unknown[] } | null)?.items;
    return Array.isArray(items) ? items.map(() => null) : [];
  }
  if (method === "workspace/workspaceFolders") return null;
  if (method === "window/showMessageRequest") return null;
  if (method === "workspace/applyEdit") return { applied: false };
  // client/registerCapability, client/unregisterCapability, window/workDoneProgress/create, and anything else.
  return null;
}
