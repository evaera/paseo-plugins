/**
 * One language server per (workspace, language), started on first need.
 *
 * Each is initialized with `rootUri` at the workspace directory. Documents are
 * kept in step with the editor through `debrief.lsp.sync` (full sync,
 * versioned); a request on a file the editor never synced opens it from disk
 * first. A server with no request for five minutes is stopped, as are a
 * workspace's servers when it is archived and every server on cleanup. A
 * crash restarts the server once; a second crash is reported until the
 * plugin reloads.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { Location } from "../../shared/rpc";
import type { LanguageId } from "../../shared/settings";
import { languageOf } from "../language";
import { LspConnection, type LspDiagnostic } from "./connection";
import { toCompletions, toHover, toLocations, toUri } from "./convert";
import { discoverServer, isExecutable, LANGUAGE_NAMES, resolveLoginPath, searchDirs } from "./discover";

const IDLE_MS = 5 * 60_000;
const INIT_TIMEOUT_MS = 60_000;

type Position = { line: number; character: number };
export type DefinitionKind = "definition" | "typeDefinition" | "implementation" | "references";

interface Session {
  key: string;
  workspaceId: string;
  language: LanguageId;
  root: string;
  connection: LspConnection;
  ready: Promise<void>;
  /** uri -> version, for documents Debrief has opened. */
  documents: Map<string, number>;
  idle: ReturnType<typeof setTimeout> | null;
  restarts: number;
  stopping: boolean;
}

const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ["utf-16"] },
  workspace: { configuration: true, workspaceFolders: true },
  textDocument: {
    synchronization: { didSave: false, willSave: false, dynamicRegistration: false },
    hover: { contentFormat: ["markdown", "plaintext"] },
    completion: {
      completionItem: { snippetSupport: false, documentationFormat: ["markdown", "plaintext"], insertReplaceSupport: false },
      contextSupport: true,
    },
    definition: { linkSupport: true },
    typeDefinition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
    publishDiagnostics: { relatedInformation: false, versionSupport: true },
  },
  window: { workDoneProgress: true },
};

export type Overrides = () => Promise<Record<string, string>>;

export class LspPool {
  private readonly sessions = new Map<string, Session>();
  /** Languages whose server crashed twice, by key, so they are not restarted in a loop. */
  private readonly broken = new Map<string, string>();
  private readonly starting = new Map<string, Promise<Session | string>>();

  constructor(private readonly overrides: Overrides) {}

  private absolute(root: string, path: string): string {
    return isAbsolute(path) ? resolve(path) : join(root, path);
  }

  /** The running session, or the reason there is none. */
  private async session(workspaceId: string, root: string, language: LanguageId): Promise<Session | string> {
    const key = `${workspaceId}\0${language}`;
    const existing = this.sessions.get(key);
    if (existing !== undefined && existing.connection.alive) return existing;
    const broken = this.broken.get(key);
    if (broken !== undefined) return broken;
    const inFlight = this.starting.get(key);
    if (inFlight !== undefined) return inFlight;
    const start = this.start(key, workspaceId, root, language, 0);
    this.starting.set(key, start);
    try {
      return await start;
    } finally {
      this.starting.delete(key);
    }
  }

  private async start(key: string, workspaceId: string, root: string, language: LanguageId, restarts: number): Promise<Session | string> {
    const overrides = await this.overrides().catch(() => ({}) as Record<string, string>);
    const command = await discoverServer(language, {
      override: overrides[language],
      searchDirs: await searchDirs(root),
      isExecutable,
    });
    if (command === null) return `No language server for ${LANGUAGE_NAMES[language]}; set one in Settings.`;
    const env = { ...process.env, PATH: await resolveLoginPath() };
    let session: Session | null = null;
    const connection = new LspConnection(command, root, env, (code, stderr) => {
      if (session !== null) this.crashed(session, code, stderr);
    });
    const created: Session = {
      key,
      workspaceId,
      language,
      root,
      connection,
      ready: Promise.resolve(),
      documents: new Map(),
      idle: null,
      restarts,
      stopping: false,
    };
    session = created;
    created.ready = (async () => {
      await connection.request(
        "initialize",
        {
          processId: process.pid,
          clientInfo: { name: "Debrief" },
          rootUri: toUri(root),
          rootPath: root,
          workspaceFolders: [{ uri: toUri(root), name: root.split("/").pop() ?? root }],
          capabilities: CLIENT_CAPABILITIES,
          initializationOptions: {},
        },
        INIT_TIMEOUT_MS,
      );
      connection.notify("initialized", {});
    })();
    this.sessions.set(key, created);
    try {
      await created.ready;
    } catch (error) {
      this.sessions.delete(key);
      void connection.stop();
      return `The ${LANGUAGE_NAMES[language]} language server did not start: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.touch(created);
    return created;
  }

  private crashed(session: Session, code: number | null, stderr: string): void {
    if (session.idle !== null) clearTimeout(session.idle);
    if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);
    if (session.stopping) return;
    console.error(`[debrief] the ${session.language} language server for ${session.workspaceId} exited (${code}): ${stderr.slice(-300)}`);
    if (session.restarts >= 1) {
      this.broken.set(session.key, `The ${LANGUAGE_NAMES[session.language]} language server keeps crashing; reload Debrief to try again.`);
      return;
    }
    // Restart once, lazily: the next request through `session()` would start a
    // fresh one with no restart count, so start it here with the count carried.
    const start = this.start(session.key, session.workspaceId, session.root, session.language, session.restarts + 1);
    this.starting.set(session.key, start);
    void start.finally(() => this.starting.delete(session.key));
  }

  private touch(session: Session): void {
    if (session.idle !== null) clearTimeout(session.idle);
    session.idle = setTimeout(() => {
      void this.stopSession(session);
    }, IDLE_MS);
    session.idle.unref();
  }

  private async stopSession(session: Session): Promise<void> {
    session.stopping = true;
    if (session.idle !== null) clearTimeout(session.idle);
    if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);
    await session.connection.stop();
  }

  private resolveLanguage(path: string): { language: LanguageId | null; lspId: string } {
    const info = languageOf(path);
    return { language: info.server, lspId: info.lspId };
  }

  /** Opens, changes or (with `text === null`) closes a document. */
  async sync(workspaceId: string, root: string, path: string, text: string | null) {
    const { language, lspId } = this.resolveLanguage(path);
    if (language === null) return { language: null, available: false, message: null };
    const session = await this.session(workspaceId, root, language);
    if (typeof session === "string") return { language, available: false, message: session };
    this.touch(session);
    const uri = toUri(this.absolute(root, path));
    const version = session.documents.get(uri);
    if (text === null) {
      if (version !== undefined) {
        session.documents.delete(uri);
        session.connection.notify("textDocument/didClose", { textDocument: { uri } });
      }
    } else if (version === undefined) {
      session.documents.set(uri, 1);
      session.connection.notify("textDocument/didOpen", { textDocument: { uri, languageId: lspId, version: 1, text } });
    } else {
      session.documents.set(uri, version + 1);
      session.connection.notify("textDocument/didChange", { textDocument: { uri, version: version + 1 }, contentChanges: [{ text }] });
    }
    return { language, available: true, message: null };
  }

  /** The session for `path` with the document open, reading it from disk if the editor never synced it. */
  private async ready(workspaceId: string, root: string, path: string): Promise<{ session: Session; uri: string } | string | null> {
    const { language, lspId } = this.resolveLanguage(path);
    if (language === null) return null;
    const session = await this.session(workspaceId, root, language);
    if (typeof session === "string") return session;
    this.touch(session);
    const absolute = this.absolute(root, path);
    const uri = toUri(absolute);
    if (!session.documents.has(uri)) {
      const text = await readFile(absolute, "utf8").catch(() => null);
      if (text === null) return `Could not read ${path}.`;
      session.documents.set(uri, 1);
      session.connection.notify("textDocument/didOpen", { textDocument: { uri, languageId: lspId, version: 1, text } });
    }
    return { session, uri };
  }

  async definition(
    workspaceId: string,
    root: string,
    path: string,
    position: Position,
    kind: DefinitionKind,
  ): Promise<{ locations: Location[]; message: string | null }> {
    const target = await this.ready(workspaceId, root, path);
    if (target === null) return { locations: [], message: "No language server handles this file." };
    if (typeof target === "string") return { locations: [], message: target };
    const params: Record<string, unknown> = { textDocument: { uri: target.uri }, position };
    if (kind === "references") params.context = { includeDeclaration: true };
    try {
      const result = await target.session.connection.request(`textDocument/${kind}`, params);
      const locations = toLocations(root, result);
      return { locations, message: locations.length === 0 ? "Nothing found." : null };
    } catch (error) {
      return { locations: [], message: error instanceof Error ? error.message : String(error) };
    }
  }

  async hover(workspaceId: string, root: string, path: string, position: Position) {
    const target = await this.ready(workspaceId, root, path);
    if (target === null || typeof target === "string") return { markdown: null, range: null };
    try {
      return toHover(await target.session.connection.request("textDocument/hover", { textDocument: { uri: target.uri }, position }));
    } catch {
      return { markdown: null, range: null };
    }
  }

  async completion(workspaceId: string, root: string, path: string, position: Position) {
    const target = await this.ready(workspaceId, root, path);
    if (target === null || typeof target === "string") return { items: [], isIncomplete: false };
    try {
      return toCompletions(
        await target.session.connection.request("textDocument/completion", {
          textDocument: { uri: target.uri },
          position,
          context: { triggerKind: 1 },
        }),
      );
    } catch {
      return { items: [], isIncomplete: false };
    }
  }

  /** What the server last published for `path`; never starts a server. */
  diagnostics(workspaceId: string, root: string, path: string): { diagnostics: Array<{ range: LspDiagnostic["range"]; severity: number | null; message: string; source: string | null }> } {
    const { language } = this.resolveLanguage(path);
    if (language === null) return { diagnostics: [] };
    const session = this.sessions.get(`${workspaceId}\0${language}`);
    if (session === undefined) return { diagnostics: [] };
    const found = session.connection.diagnostics.get(toUri(this.absolute(root, path))) ?? [];
    return {
      diagnostics: found.map((entry) => ({
        range: entry.range,
        severity: entry.severity ?? null,
        message: entry.message,
        source: entry.source ?? null,
      })),
    };
  }

  async stopWorkspace(workspaceId: string): Promise<void> {
    const sessions = [...this.sessions.values()].filter((session) => session.workspaceId === workspaceId);
    for (const key of [...this.broken.keys()]) if (key.startsWith(`${workspaceId}\0`)) this.broken.delete(key);
    await Promise.all(sessions.map((session) => this.stopSession(session)));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => this.stopSession(session)));
    this.broken.clear();
  }
}
