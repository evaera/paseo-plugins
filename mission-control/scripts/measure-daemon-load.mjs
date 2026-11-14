// node scripts/measure-daemon-load.mjs <daemon.log> [minutes=15] [end=ISO timestamp]
// Read only. Logs contain slow requests by client; runtime totals cover every client together.
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
console.log(JSON.stringify({
  since: new Date(since).toISOString(), until: new Date(until).toISOString(), minutes: Number(minutes),
  slowRequests: [...groups].map(([clientAndType, durations]) => ({
    clientAndType, count: durations.length, perMinute: +(durations.length / Number(minutes)).toFixed(2),
    p50Ms: percentile(durations, 0.5), maxMs: Math.max(...durations),
  })).sort((a, b) => b.count - a.count),
  configReadTimeouts: selected.filter((row) => row.msg === "Failed to parse paseo.json; treating workspace as having no scripts" && row.err?.message === "Project config unavailable").length,
  runtimeWindows: metrics.length, runtimeWindowMinutes: +metricMinutes.toFixed(2),
  globalRequestsPerMinute: [...requestTotals].map(([type, count]) => ({ type, count, perMinute: +(count / metricMinutes).toFixed(2) })).sort((a, b) => b.count - a.count),
  eventLoopP99Ms: { median: percentile(metrics.map((row) => row.eventLoopDelay?.p99Ms).filter(Number.isFinite), 0.5), max: Math.max(0, ...metrics.map((row) => row.eventLoopDelay?.p99Ms ?? 0)) },
  latest: metrics.at(-1),
}, null, 2));
