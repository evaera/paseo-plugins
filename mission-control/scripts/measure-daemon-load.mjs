// node scripts/measure-daemon-load.mjs <daemon.log> [minutes=15] [end=ISO timestamp]
// Read only. Logs contain slow requests by client; runtime totals cover every client together.
// pluginRpcMetricsWindows=0 means per-method telemetry is unavailable, not that no RPCs ran.
// Per-method counts cover all clients of each plugin. Handler time includes awaited I/O/SDK calls,
// but excludes daemon scheduling, IPC and wire validation. CPU is for the whole plugin process.
import { readFileSync } from "node:fs";

const [, , path, minutes = "15", end] = process.argv;
if (!path || !(Number(minutes) > 0)) throw new Error("Pass a daemon.log path and a positive window in minutes.");
const rows = readFileSync(path, "utf8").split("\n").flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const until = end ? Date.parse(end) : Math.max(...rows.map((row) => Number(row.time) || 0));
if (!Number.isFinite(until)) throw new Error("Invalid end timestamp.");
const since = until - Number(minutes) * 60_000;
const selected = rows.filter((row) => row.time >= since && row.time < until);
const percentile = (values, fraction) => {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered.length ? ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))] : null;
};
const groups = new Map();
for (const row of selected.filter((row) => row.msg === "ws_slow_request")) {
  const key = `${row.clientId ?? "unknown"} ${row.requestType ?? "unknown"}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row.durationMs);
}
const metrics = selected.filter((row) => row.msg === "ws_runtime_metrics");
const requestTotals = new Map();
for (const row of metrics) {
  for (const [type, count] of row.inboundSessionRequestTypesTop ?? []) requestTotals.set(type, (requestTotals.get(type) ?? 0) + count);
}
const metricMinutes = metrics.reduce((sum, row) => sum + row.windowMs, 0) / 60_000;
const rpcWindows = selected.flatMap((row) => {
  if (row.msg !== "Plugin output" || typeof row.message !== "string") return [];
  try {
    const entry = JSON.parse(row.message);
    return entry.event === "plugin_rpc_metrics" ? [entry] : [];
  } catch { return []; }
});
const rpcMethods = new Map();
const processes = new Map();
const timelineTails = new Map();
const coordinatorSends = new Map();
for (const row of selected) {
  if (row.msg !== "Plugin output" || typeof row.message !== "string") continue;
  let event;
  try { event = JSON.parse(row.message); } catch { continue; }
  if (event.event === "plugin_coordinator_send") {
    const key = `${event.agentId}/${event.messageId}`;
    const send = coordinatorSends.get(key) ?? { agentId: event.agentId, messageId: event.messageId, started: 0, accepted: 0, unknown: 0, maxMs: 0 };
    if (event.phase === "start") send.started += 1;
    else if (event.phase === "accepted") send.accepted += 1;
    else if (event.phase === "unknown") send.unknown += 1;
    send.maxMs = Math.max(send.maxMs, event.durationMs ?? 0);
    coordinatorSends.set(key, send);
    continue;
  }
  if (event.event !== "plugin_timeline_tail") continue;
  const key = `${event.source}/${event.agentId}`;
  const tail = timelineTails.get(key) ?? { agentId: event.agentId, source: event.source, started: 0, completed: 0, failed: 0, totalMs: 0, maxMs: 0, maxItems: 0 };
  if (event.phase === "start") tail.started += 1;
  else {
    if (event.phase === "complete") tail.completed += 1;
    else tail.failed += 1;
    tail.totalMs += event.durationMs ?? 0;
    tail.maxMs = Math.max(tail.maxMs, event.durationMs ?? 0);
    tail.maxItems = Math.max(tail.maxItems, event.items ?? 0);
  }
  timelineTails.set(key, tail);
}
for (const window of rpcWindows) {
  const processKey = `${window.plugin}/${window.pid}`;
  const cpu = processes.get(processKey) ?? { plugin: window.plugin, pid: window.pid, windowMs: 0, processCpuMs: 0 };
  cpu.windowMs += window.windowMs;
  cpu.processCpuMs += window.processCpuMs;
  processes.set(processKey, cpu);
  for (const method of window.methods) {
    const key = `${window.plugin}/${method.method}`;
    const total = rpcMethods.get(key) ?? { plugin: window.plugin, method: method.method, started: 0, completed: 0, failed: 0, handlerWallMs: 0, handlerMaxMs: 0, inFlight: 0 };
    total.started += method.started;
    total.completed += method.completed;
    total.failed += method.failed;
    total.handlerWallMs += method.handlerWallMs;
    total.handlerMaxMs = Math.max(total.handlerMaxMs, method.handlerMaxMs);
    total.inFlight = method.inFlight;
    rpcMethods.set(key, total);
  }
}
console.log(JSON.stringify({
  since: new Date(since).toISOString(), until: new Date(until).toISOString(), minutes: Number(minutes),
  slowRequests: [...groups].map(([clientAndType, durations]) => ({
    clientAndType, count: durations.length, perMinute: +(durations.length / Number(minutes)).toFixed(2),
    p50Ms: percentile(durations, 0.5), maxMs: Math.max(...durations),
  })).sort((a, b) => b.count - a.count),
  configReadTimeouts: selected.filter((row) => row.msg === "Failed to parse paseo.json; treating workspace as having no scripts" && row.err?.message === "Project config unavailable").length,
  pluginRpcMetricsWindows: rpcWindows.length,
  pluginTimelineTails: [...timelineTails.values()],
  pluginCoordinatorSends: [...coordinatorSends.values()],
  // Handler times exclude IPC, daemon scheduling, and input/output validation. They include awaited I/O/SDK calls.
  pluginRpcMethods: [...rpcMethods.values()].map((method) => ({ ...method,
    startedPerMinute: +(method.started / Number(minutes)).toFixed(2),
    handlerMeanMs: method.completed ? +(method.handlerWallMs / method.completed).toFixed(3) : null,
  })).sort((a, b) => b.started - a.started),
  pluginProcesses: [...processes.values()].map((cpu) => ({ ...cpu, cpuFraction: cpu.windowMs ? +(cpu.processCpuMs / cpu.windowMs).toFixed(4) : null })),
  runtimeWindows: metrics.length, runtimeWindowMinutes: +metricMinutes.toFixed(2),
  globalRequestsPerMinute: [...requestTotals].map(([type, count]) => ({ type, count, perMinute: +(count / metricMinutes).toFixed(2) })).sort((a, b) => b.count - a.count),
  eventLoopP99Ms: { median: percentile(metrics.map((row) => row.eventLoopDelay?.p99Ms).filter(Number.isFinite), 0.5), max: Math.max(0, ...metrics.map((row) => row.eventLoopDelay?.p99Ms ?? 0)) },
  latest: metrics.at(-1),
}, null, 2));
