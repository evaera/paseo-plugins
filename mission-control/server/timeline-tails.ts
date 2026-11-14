/** One queue for board reports and explicit steer relays. Never log timeline contents. */
import type { PaseoApi, TimelinePage } from "./host-types";

export const REPORT_TAIL = 30;

export class TimelineTails {
  private active = 0;
  private readonly jobs: Array<() => Promise<void>> = [];

  read(paseo: PaseoApi, options: {
    agentId: string;
    source: "board-report" | "local-steer-relay" | "remote-steer-relay";
    updatedAt?: string;
    allowed?: () => boolean;
  }): Promise<TimelinePage | null> {
    return new Promise((resolve, reject) => {
      this.jobs.push(async () => {
        let started: number | undefined;
        const fields = { event: "plugin_timeline_tail", source: options.source, agentId: options.agentId, updatedAt: options.updatedAt, limit: REPORT_TAIL };
        try {
          if (options.allowed !== undefined && !options.allowed()) { resolve(null); return; }
          started = Date.now();
          console.log(JSON.stringify({ ...fields, phase: "start" }));
          const page = await paseo.agents.ref(options.agentId).timeline.refetch({ direction: "tail", limit: REPORT_TAIL, projection: "projected" });
          if (page.error) throw new Error(page.error);
          console.log(JSON.stringify({ ...fields, phase: "complete", durationMs: Date.now() - started, items: page.entries.length }));
          resolve(page);
        } catch (error) {
          if (started !== undefined) console.log(JSON.stringify({ ...fields, phase: "failed", durationMs: Date.now() - started }));
          reject(error);
        }
      });
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < 2 && this.jobs.length > 0) {
      const job = this.jobs.shift()!;
      this.active += 1;
      void job().finally(() => { this.active -= 1; this.pump(); });
    }
  }
}

export const timelineTails = new TimelineTails();
