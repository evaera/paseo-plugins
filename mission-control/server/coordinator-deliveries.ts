/** Durable send intent: an ambiguous outcome must never become another send. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CoordinatorDeliverySchema, type CoordinatorDelivery } from "../shared/fleet";
import { pluginDir } from "./data-dir";
import { serialized } from "./serialize";

export class UnconfirmedDelivery extends Error {}

interface SavedDelivery extends CoordinatorDelivery { fingerprint: string }

export class CoordinatorDeliveries {
  private readonly active = new Set<string>();
  constructor(private readonly directory = () => join(pluginDir(), "deliveries")) {}

  private path(id: string): string {
    if (!/^[a-z0-9-]{1,128}$/.test(id)) throw new Error("Invalid delivery id.");
    return join(this.directory(), `${id}.json`);
  }

  private async read(id: string): Promise<SavedDelivery | null> {
    try {
      const raw = JSON.parse(await readFile(this.path(id), "utf8")) as SavedDelivery;
      return { ...CoordinatorDeliverySchema.parse(raw), fingerprint: raw.fingerprint };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async save(record: SavedDelivery): Promise<void> {
    const path = this.path(record.messageId), temporary = `${path}.${randomUUID()}.tmp`;
    await mkdir(this.directory(), { recursive: true });
    await writeFile(temporary, JSON.stringify(record), "utf8");
    await rename(temporary, path);
  }

  async status(messageId: string): Promise<CoordinatorDelivery> {
    const record = await this.read(messageId);
    if (record === null) return { messageId, state: "missing", agentId: null };
    // A plugin restart cannot establish whether its old send reached the daemon.
    if (record.state === "sending" && !this.active.has(this.path(messageId))) return { ...record, state: "unknown" };
    return record;
  }

  submit(messageId: string, request: unknown, send: () => Promise<string>): Promise<CoordinatorDelivery> {
    const path = this.path(messageId);
    return serialized(path, async () => {
      const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
      const existing = await this.read(messageId);
      if (existing !== null) {
        if (existing.fingerprint !== fingerprint) throw new Error("This delivery id already belongs to another message.");
        return this.status(messageId);
      }
      const record: SavedDelivery = { messageId, fingerprint, state: "sending", agentId: null };
      // Fail closed if saving fails. No wire operation may precede this write.
      await this.save(record);
      this.active.add(path);
      void Promise.resolve().then(send).then(
        (agentId) => this.save({ ...record, state: "sent", agentId }),
        (error: unknown) => this.save({ ...record, state: error instanceof UnconfirmedDelivery ? "unknown" : "failed", error: error instanceof Error ? error.message : String(error) }),
      ).catch((error: unknown) => console.error("[mission-control] could not save delivery outcome:", error))
        .finally(() => this.active.delete(path));
      return record;
    });
  }
}

export const coordinatorDeliveries = new CoordinatorDeliveries();
