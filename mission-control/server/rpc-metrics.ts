/** Local, aggregate timings only. Inputs and outputs never enter the log. */
import { performance } from "node:perf_hooks";
import type { PluginServerContext } from "@getpaseo/plugin/server";

interface MethodMetrics {
  method: string;
  started: number;
  completed: number;
  failed: number;
  inFlight: number;
  handlerWallMs: number;
  handlerMaxMs: number;
}

export function measureRpcHandlers(server: Pick<PluginServerContext, "handle">, plugin: string) {
  const methods = new Map<string, MethodMetrics>();
  let since = performance.now();
  let cpu = process.cpuUsage();
  function flush(): void {
    const now = performance.now();
    const nextCpu = process.cpuUsage();
    const active = [...methods.values()].filter((method) => method.started || method.completed || method.inFlight);
    console.log(JSON.stringify({
      event: "plugin_rpc_metrics", plugin, pid: process.pid, windowMs: now - since,
      processCpuMs: (nextCpu.user + nextCpu.system - cpu.user - cpu.system) / 1000,
      methods: active.map((method) => ({ ...method })),
    }));
    methods.forEach((method) => {
      method.started = method.completed = method.failed = method.handlerWallMs = method.handlerMaxMs = 0;
    });
    since = now;
    cpu = nextCpu;
  }
  const handle: PluginServerContext["handle"] = (contract, handler) => {
    const metric: MethodMetrics = { method: contract.name, started: 0, completed: 0, failed: 0, inFlight: 0, handlerWallMs: 0, handlerMaxMs: 0 };
    methods.set(contract.name, metric);
    server.handle(contract, async (input, context) => {
      const started = performance.now();
      metric.started += 1;
      metric.inFlight += 1;
      try {
        return await handler(input, context);
      } catch (error) {
        metric.failed += 1;
        throw error;
      } finally {
        const duration = performance.now() - started;
        metric.completed += 1;
        metric.inFlight -= 1;
        metric.handlerWallMs += duration;
        metric.handlerMaxMs = Math.max(metric.handlerMaxMs, duration);
      }
    });
  };
  const timer = setInterval(flush, 30_000);
  let stopped = false;
  return { handle, stop() { if (stopped) return; stopped = true; clearInterval(timer); flush(); } };
}
