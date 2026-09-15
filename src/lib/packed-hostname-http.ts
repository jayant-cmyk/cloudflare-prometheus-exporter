import { z } from "zod";
import type { MetricDefinition } from "./metrics";
import { serializeColumnarMetrics } from "./packed-columnar-prometheus";
import type { ColumnarFamily } from "./packed-columnar-state";
import type { SerializeOptions } from "./prometheus";

export const HOSTNAME_HTTP_METRICS_QUERY_NAME = "hostname-http-metrics";

const HostCountRowSchema = z.object({ host: z.string(), count: z.number() });
const HostStatusRowSchema = HostCountRowSchema.extend({ status: z.string() });
const HostCacheRowSchema = HostCountRowSchema.extend({
	cacheStatus: z.string(),
});
const HostLatencyRowSchema = z.object({
	host: z.string(),
	edgeTtfbMs: z.number().nullable(),
	edgeTtfbP50Ms: z.number().nullable(),
	edgeTtfbP95Ms: z.number().nullable(),
	originDurationMs: z.number().nullable(),
	originDurationP50Ms: z.number().nullable(),
	originDurationP95Ms: z.number().nullable(),
});
const PackedHostnameHttpZoneSchema = z.object({
	zone: z.string(),
	requestRows: z.array(HostCountRowSchema),
	statusRows: z.array(HostStatusRowSchema),
	cacheRows: z.array(HostCacheRowSchema),
	latencyRows: z.array(HostLatencyRowSchema),
});

export const PackedHostnameHttpMetricStateSchema = z.object({
	format: z.literal("hostname-http-packed-by-zone-v1"),
	accountId: z.string(),
	accountName: z.string(),
	queryName: z.literal(HOSTNAME_HTTP_METRICS_QUERY_NAME),
	lastFetch: z.number(),
	lastIngest: z.number(),
	zones: z.array(PackedHostnameHttpZoneSchema),
});

export type PackedHostnameHttpZone = z.infer<
	typeof PackedHostnameHttpZoneSchema
>;
export type PackedHostnameHttpMetricState = z.infer<
	typeof PackedHostnameHttpMetricStateSchema
>;

const REQUEST_FAMILIES: readonly ColumnarFamily[] = [
	{
		name: "cloudflare_zone_hostname_requests",
		help: "Requests per hostname in the last completed minute",
		type: "gauge",
		valueIndex: 0,
	},
];
const STATUS_FAMILIES: readonly ColumnarFamily[] = [
	{
		name: "cloudflare_zone_hostname_requests_by_status",
		help: "Requests per hostname by edge response status in the last completed minute",
		type: "gauge",
		valueIndex: 0,
	},
];
const CACHE_FAMILIES: readonly ColumnarFamily[] = [
	{
		name: "cloudflare_zone_hostname_cache_status",
		help: "Requests per hostname by cache status in the last completed minute",
		type: "gauge",
		valueIndex: 0,
	},
];
const LATENCY_FAMILIES: readonly ColumnarFamily[] = [
	{
		name: "cloudflare_zone_hostname_edge_ttfb_seconds",
		help: "Average edge time to first byte per hostname in seconds (last completed minute)",
		type: "gauge",
		valueIndex: 0,
	},
	{
		name: "cloudflare_zone_hostname_edge_ttfb_p50_seconds",
		help: "P50 edge time to first byte per hostname in seconds (last completed minute)",
		type: "gauge",
		valueIndex: 1,
	},
	{
		name: "cloudflare_zone_hostname_edge_ttfb_p95_seconds",
		help: "P95 edge time to first byte per hostname in seconds (last completed minute)",
		type: "gauge",
		valueIndex: 2,
	},
	{
		name: "cloudflare_zone_hostname_origin_response_duration_seconds",
		help: "Average origin response duration per hostname in seconds (last completed minute)",
		type: "gauge",
		valueIndex: 3,
	},
	{
		name: "cloudflare_zone_hostname_origin_response_duration_p50_seconds",
		help: "P50 origin response duration per hostname in seconds (last completed minute)",
		type: "gauge",
		valueIndex: 4,
	},
	{
		name: "cloudflare_zone_hostname_origin_response_duration_p95_seconds",
		help: "P95 origin response duration per hostname in seconds (last completed minute)",
		type: "gauge",
		valueIndex: 5,
	},
];

function values(metrics: readonly MetricDefinition[], name: string) {
	return metrics.find((metric) => metric.name === name)?.values ?? [];
}

export function buildPackedHostnameHttpZones(
	previous: PackedHostnameHttpMetricState | undefined,
	metrics: readonly MetricDefinition[],
	failedScopes: ReadonlySet<string>,
): PackedHostnameHttpZone[] {
	const zones = new Map<string, PackedHostnameHttpZone>();
	const zoneFor = (zone: string) => {
		const existing = zones.get(zone);
		if (existing !== undefined) return existing;
		const created: PackedHostnameHttpZone = {
			zone,
			requestRows: [],
			statusRows: [],
			cacheRows: [],
			latencyRows: [],
		};
		zones.set(zone, created);
		return created;
	};
	const requestRows = new Map<
		string,
		{ zone: string; host: string; count: number }
	>();
	for (const value of values(metrics, REQUEST_FAMILIES[0]?.name ?? "")) {
		const zone = value.labels.zone ?? "";
		const host = (value.labels.host ?? "").toLowerCase();
		const key = `${zone}\x00${host}`;
		const previousValue =
			requestRows.get(key)?.count ?? Number.NEGATIVE_INFINITY;
		requestRows.set(key, {
			zone,
			host,
			count: Math.max(previousValue, value.value),
		});
	}
	for (const row of requestRows.values()) {
		zoneFor(row.zone).requestRows.push({ host: row.host, count: row.count });
	}
	const statusRows = new Map<
		string,
		{ zone: string; host: string; status: string; count: number }
	>();
	for (const value of values(metrics, STATUS_FAMILIES[0]?.name ?? "")) {
		const zone = value.labels.zone ?? "";
		const host = (value.labels.host ?? "").toLowerCase();
		const status = value.labels.status ?? "";
		const key = `${zone}\x00${host}\x00${status}`;
		const previousValue =
			statusRows.get(key)?.count ?? Number.NEGATIVE_INFINITY;
		statusRows.set(key, {
			zone,
			host,
			status,
			count: Math.max(previousValue, value.value),
		});
	}
	for (const row of statusRows.values()) {
		zoneFor(row.zone).statusRows.push({
			host: row.host,
			status: row.status,
			count: row.count,
		});
	}
	const cacheRows = new Map<
		string,
		{ zone: string; host: string; cacheStatus: string; count: number }
	>();
	for (const value of values(metrics, CACHE_FAMILIES[0]?.name ?? "")) {
		const zone = value.labels.zone ?? "";
		const host = (value.labels.host ?? "").toLowerCase();
		const cacheStatus = value.labels.cache_status ?? "";
		const key = `${zone}\x00${host}\x00${cacheStatus}`;
		const previousValue = cacheRows.get(key)?.count ?? Number.NEGATIVE_INFINITY;
		cacheRows.set(key, {
			zone,
			host,
			cacheStatus,
			count: Math.max(previousValue, value.value),
		});
	}
	for (const row of cacheRows.values()) {
		zoneFor(row.zone).cacheRows.push({
			host: row.host,
			cacheStatus: row.cacheStatus,
			count: row.count,
		});
	}
	const latencyRows = new Map<
		string,
		PackedHostnameHttpZone["latencyRows"][number]
	>();
	for (const [valueIndex, family] of LATENCY_FAMILIES.entries()) {
		for (const value of values(metrics, family.name)) {
			const zoneName = value.labels.zone ?? "";
			const host = (value.labels.host ?? "").toLowerCase();
			const key = `${zoneName}\x00${host}`;
			const row = latencyRows.get(key) ?? {
				host,
				edgeTtfbMs: null,
				edgeTtfbP50Ms: null,
				edgeTtfbP95Ms: null,
				originDurationMs: null,
				originDurationP50Ms: null,
				originDurationP95Ms: null,
			};
			const milliseconds = value.value * 1000;
			if (valueIndex === 0)
				row.edgeTtfbMs = Math.max(
					row.edgeTtfbMs ?? Number.NEGATIVE_INFINITY,
					milliseconds,
				);
			if (valueIndex === 1)
				row.edgeTtfbP50Ms = Math.max(
					row.edgeTtfbP50Ms ?? Number.NEGATIVE_INFINITY,
					milliseconds,
				);
			if (valueIndex === 2)
				row.edgeTtfbP95Ms = Math.max(
					row.edgeTtfbP95Ms ?? Number.NEGATIVE_INFINITY,
					milliseconds,
				);
			if (valueIndex === 3)
				row.originDurationMs = Math.max(
					row.originDurationMs ?? Number.NEGATIVE_INFINITY,
					milliseconds,
				);
			if (valueIndex === 4)
				row.originDurationP50Ms = Math.max(
					row.originDurationP50Ms ?? Number.NEGATIVE_INFINITY,
					milliseconds,
				);
			if (valueIndex === 5)
				row.originDurationP95Ms = Math.max(
					row.originDurationP95Ms ?? Number.NEGATIVE_INFINITY,
					milliseconds,
				);
			latencyRows.set(key, row);
			zoneFor(zoneName);
		}
	}
	for (const [key, row] of latencyRows) {
		zoneFor(key.split("\x00")[0] ?? "").latencyRows.push(row);
	}
	for (const zone of previous?.zones ?? []) {
		if (failedScopes.has(zone.zone)) zones.set(zone.zone, zone);
	}
	return [...zones.values()];
}

function requestSamples(states: readonly PackedHostnameHttpMetricState[]) {
	return function* samples() {
		for (const state of states)
			for (const zone of state.zones)
				for (const row of zone.requestRows)
					yield { zone: zone.zone, keys: [row.host], value: row.count };
	};
}

function statusSamples(states: readonly PackedHostnameHttpMetricState[]) {
	return function* samples() {
		for (const state of states)
			for (const zone of state.zones)
				for (const row of zone.statusRows)
					yield {
						zone: zone.zone,
						keys: [row.host, row.status],
						value: row.count,
					};
	};
}

function cacheSamples(states: readonly PackedHostnameHttpMetricState[]) {
	return function* samples() {
		for (const state of states)
			for (const zone of state.zones)
				for (const row of zone.cacheRows)
					yield {
						zone: zone.zone,
						keys: [row.host, row.cacheStatus],
						value: row.count,
					};
	};
}

function latencySamples(states: readonly PackedHostnameHttpMetricState[]) {
	return function* samples(valueIndex: number) {
		for (const state of states) {
			for (const zone of state.zones) {
				for (const row of zone.latencyRows) {
					const values = [
						row.edgeTtfbMs,
						row.edgeTtfbP50Ms,
						row.edgeTtfbP95Ms,
						row.originDurationMs,
						row.originDurationP50Ms,
						row.originDurationP95Ms,
					];
					const value = values[valueIndex];
					if (value != null) {
						yield { zone: zone.zone, keys: [row.host], value: value / 1000 };
					}
				}
			}
		}
	};
}

export function* serializePackedHostnameHttpMetrics(
	states: readonly PackedHostnameHttpMetricState[],
	options: SerializeOptions,
): Generator<string> {
	yield* serializeColumnarMetrics(
		requestSamples(states),
		REQUEST_FAMILIES,
		["host"],
		options,
	);
	yield* serializeColumnarMetrics(
		statusSamples(states),
		STATUS_FAMILIES,
		["host", "status"],
		options,
	);
	yield* serializeColumnarMetrics(
		cacheSamples(states),
		CACHE_FAMILIES,
		["host", "cache_status"],
		options,
	);
	yield* serializeColumnarMetrics(
		latencySamples(states),
		LATENCY_FAMILIES,
		["host"],
		options,
	);
}
