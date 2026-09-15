import { z } from "zod";
import type { MetricDefinition } from "./metrics";
import { serializeColumnarMetrics } from "./packed-columnar-prometheus";
import {
	accumulateColumnarZones,
	type ColumnarFamily,
	type ColumnarZoneRows,
	observeColumnarWindow,
} from "./packed-columnar-state";
import type { SerializeOptions } from "./prometheus";

export const HEALTH_CHECK_METRICS_QUERY_NAME = "health-check-metrics";
export const HEALTH_CHECK_EVENTS_METRIC_NAME =
	"cloudflare_zone_health_check_events_origin_total";

const HealthEventRowSchema = z.object({
	healthStatus: z.string(),
	originIp: z.string(),
	region: z.string(),
	fqdn: z.string(),
	failureReason: z.string(),
	count: z.number(),
	misses: z.number().int().nonnegative(),
	lastIngest: z.number(),
});
const HealthTimingRowSchema = z.object({
	originIp: z.string(),
	fqdn: z.string(),
	rttMs: z.number().nullable(),
	ttfbMs: z.number().nullable(),
	tcpConnMs: z.number().nullable(),
	tlsHandshakeMs: z.number().nullable(),
});
const PackedHealthCheckZoneSchema = z.object({
	zone: z.string(),
	eventRows: z.array(HealthEventRowSchema),
	timingRows: z.array(HealthTimingRowSchema),
	totalEvents: z.number(),
	groupCount: z.number().int().nonnegative(),
});

export const PackedHealthCheckMetricStateSchema = z.object({
	format: z.literal("health-check-packed-by-zone-v1"),
	accountId: z.string(),
	accountName: z.string(),
	queryName: z.literal(HEALTH_CHECK_METRICS_QUERY_NAME),
	lastFetch: z.number(),
	lastIngest: z.number(),
	zones: z.array(PackedHealthCheckZoneSchema),
});

export type PackedHealthCheckZone = z.infer<typeof PackedHealthCheckZoneSchema>;
export type PackedHealthCheckMetricState = z.infer<
	typeof PackedHealthCheckMetricStateSchema
>;

const EVENT_LABELS = [
	"health_status",
	"origin_ip",
	"region",
	"fqdn",
	"failure_reason",
] as const;
const TIMING_LABELS = ["origin_ip", "fqdn"] as const;
const EVENT_FAMILIES: readonly ColumnarFamily[] = [
	{
		name: HEALTH_CHECK_EVENTS_METRIC_NAME,
		help: "Health check events per origin",
		valueIndex: 0,
	},
];
const TIMING_FAMILIES: readonly ColumnarFamily[] = [
	{
		name: "cloudflare_zone_health_check_rtt_seconds",
		help: "Health check RTT to origin in seconds",
		type: "gauge",
		valueIndex: 0,
	},
	{
		name: "cloudflare_zone_health_check_ttfb_seconds",
		help: "Health check time to first byte in seconds",
		type: "gauge",
		valueIndex: 1,
	},
	{
		name: "cloudflare_zone_health_check_tcp_connection_seconds",
		help: "Health check TCP connection time in seconds",
		type: "gauge",
		valueIndex: 2,
	},
	{
		name: "cloudflare_zone_health_check_tls_handshake_seconds",
		help: "Health check TLS handshake time in seconds",
		type: "gauge",
		valueIndex: 3,
	},
];
const EVENTS_AVG_FAMILIES: readonly ColumnarFamily[] = [
	{
		name: "cloudflare_zone_health_check_events_avg",
		help: "Average health check events",
		type: "gauge",
		valueIndex: 0,
	},
];

function eventColumnarZones(
	zones: readonly PackedHealthCheckZone[],
): ColumnarZoneRows[] {
	return zones.map((zone) => ({
		zone: zone.zone,
		rows: zone.eventRows.map((row) => ({
			keys: [
				row.healthStatus,
				row.originIp,
				row.region,
				row.fqdn,
				row.failureReason,
			],
			values: [row.count],
			misses: row.misses,
			lastIngest: row.lastIngest,
		})),
	}));
}

function timingRows(metrics: readonly MetricDefinition[]) {
	const zones = new Map<
		string,
		Map<string, PackedHealthCheckZone["timingRows"][number]>
	>();
	for (const [valueIndex, family] of TIMING_FAMILIES.entries()) {
		for (const value of metrics.find((metric) => metric.name === family.name)
			?.values ?? []) {
			const zone = value.labels.zone ?? "";
			const originIp = value.labels.origin_ip ?? "";
			const fqdn = value.labels.fqdn ?? "";
			const rows = zones.get(zone) ?? new Map();
			const key = `${originIp}\x00${fqdn}`;
			const row = rows.get(key) ?? {
				originIp,
				fqdn,
				rttMs: null,
				ttfbMs: null,
				tcpConnMs: null,
				tlsHandshakeMs: null,
			};
			const field = ["rttMs", "ttfbMs", "tcpConnMs", "tlsHandshakeMs"][
				valueIndex
			];
			if (field === "rttMs") row.rttMs = value.value * 1000;
			if (field === "ttfbMs") row.ttfbMs = value.value * 1000;
			if (field === "tcpConnMs") row.tcpConnMs = value.value * 1000;
			if (field === "tlsHandshakeMs") row.tlsHandshakeMs = value.value * 1000;
			rows.set(key, row);
			zones.set(zone, rows);
		}
	}
	return zones;
}

export function accumulatePackedHealthCheckRows(
	previous: PackedHealthCheckMetricState | undefined,
	metrics: readonly MetricDefinition[],
	ingestId: number,
	failedScopes: ReadonlySet<string>,
): PackedHealthCheckZone[] {
	const events = accumulateColumnarZones(
		eventColumnarZones(previous?.zones ?? []),
		observeColumnarWindow(metrics, EVENT_FAMILIES, EVENT_LABELS, 1),
		ingestId,
		previous?.lastIngest !== ingestId,
		failedScopes,
	);
	const timings = timingRows(metrics);
	const eventsByZone = new Map(events.map((bucket) => [bucket.zone, bucket]));
	const zoneNames = new Set([...eventsByZone.keys(), ...timings.keys()]);
	for (const zone of previous?.zones ?? []) {
		if (failedScopes.has(zone.zone)) zoneNames.add(zone.zone);
	}
	return [...zoneNames].map((zoneName) => {
		const bucket = eventsByZone.get(zoneName);
		const previousZone = previous?.zones.find((zone) => zone.zone === zoneName);
		const rawEvents =
			metrics
				.find((metric) => metric.name === HEALTH_CHECK_EVENTS_METRIC_NAME)
				?.values.filter((value) => value.labels.zone === zoneName) ?? [];
		return {
			zone: zoneName,
			eventRows: (bucket?.rows ?? []).map((row) => ({
				healthStatus: row.keys[0] ?? "",
				originIp: row.keys[1] ?? "",
				region: row.keys[2] ?? "",
				fqdn: row.keys[3] ?? "",
				failureReason: row.keys[4] ?? "",
				count: row.values[0] ?? 0,
				misses: row.misses,
				lastIngest: row.lastIngest,
			})),
			timingRows: failedScopes.has(zoneName)
				? (previousZone?.timingRows ?? [])
				: [...(timings.get(zoneName)?.values() ?? [])],
			totalEvents: failedScopes.has(zoneName)
				? (previousZone?.totalEvents ?? 0)
				: rawEvents.reduce((total, value) => total + value.value, 0),
			groupCount: failedScopes.has(zoneName)
				? (previousZone?.groupCount ?? 0)
				: rawEvents.length,
		};
	});
}

function eventSamples(states: readonly PackedHealthCheckMetricState[]) {
	return function* samples() {
		for (const state of states) {
			for (const zone of state.zones) {
				for (const row of zone.eventRows) {
					yield {
						zone: zone.zone,
						keys: [
							row.healthStatus,
							row.originIp,
							row.region,
							row.fqdn,
							row.failureReason,
						],
						value: row.count,
					};
				}
			}
		}
	};
}

function timingSamples(states: readonly PackedHealthCheckMetricState[]) {
	return function* samples(valueIndex: number) {
		const field = ["rttMs", "ttfbMs", "tcpConnMs", "tlsHandshakeMs"][
			valueIndex
		];
		for (const state of states) {
			for (const zone of state.zones) {
				for (const row of zone.timingRows) {
					const value =
						field === "rttMs"
							? row.rttMs
							: field === "ttfbMs"
								? row.ttfbMs
								: field === "tcpConnMs"
									? row.tcpConnMs
									: row.tlsHandshakeMs;
					if (value != null) {
						yield {
							zone: zone.zone,
							keys: [row.originIp, row.fqdn],
							value: value / 1000,
						};
					}
				}
			}
		}
	};
}

function eventAverageSamples(states: readonly PackedHealthCheckMetricState[]) {
	return function* samples() {
		for (const state of states) {
			for (const zone of state.zones) {
				if (zone.groupCount > 0) {
					yield {
						zone: zone.zone,
						keys: [],
						value: zone.totalEvents / zone.groupCount,
					};
				}
			}
		}
	};
}

export function* serializePackedHealthCheckMetrics(
	states: readonly PackedHealthCheckMetricState[],
	options: SerializeOptions,
): Generator<string> {
	yield* serializeColumnarMetrics(
		eventSamples(states),
		EVENT_FAMILIES,
		EVENT_LABELS,
		options,
	);
	yield* serializeColumnarMetrics(
		eventAverageSamples(states),
		EVENTS_AVG_FAMILIES,
		[],
		options,
	);
	yield* serializeColumnarMetrics(
		timingSamples(states),
		TIMING_FAMILIES,
		TIMING_LABELS,
		options,
	);
}
