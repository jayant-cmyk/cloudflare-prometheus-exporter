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

export const EDGE_COUNTRY_METRICS_QUERY_NAME = "edge-country-metrics";
export const EDGE_COUNTRY_METRIC_NAME =
	"cloudflare_zone_requests_status_country_host_total";
export const EDGE_COUNTRY_ERROR_RATE_METRIC_NAME =
	"cloudflare_zone_edge_error_rate";

const PackedEdgeCountryZoneSchema = z
	.object({
		zone: z.string(),
		edgeStatus: z.array(z.string()),
		country: z.array(z.string()),
		host: z.array(z.string()),
		count: z.array(z.number()),
		misses: z.array(z.number().int().nonnegative()),
		lastIngest: z.array(z.number()),
		total: z.number(),
		errors: z.number(),
	})
	.refine(
		(zone) =>
			[zone.country, zone.host, zone.count, zone.misses, zone.lastIngest].every(
				(column) => column.length === zone.edgeStatus.length,
			),
		{ message: "Packed edge country zone columns must have equal length" },
	);

export const PackedEdgeCountryMetricStateSchema = z.object({
	format: z.literal("edge-country-packed-by-zone-v1"),
	accountId: z.string(),
	accountName: z.string(),
	queryName: z.literal(EDGE_COUNTRY_METRICS_QUERY_NAME),
	lastFetch: z.number(),
	lastIngest: z.number(),
	zones: z.array(PackedEdgeCountryZoneSchema),
});

export type PackedEdgeCountryZone = z.infer<typeof PackedEdgeCountryZoneSchema>;
export type PackedEdgeCountryMetricState = z.infer<
	typeof PackedEdgeCountryMetricStateSchema
>;

const EDGE_COUNTRY_KEY_LABELS = ["edge_status", "country", "host"] as const;
const EDGE_COUNTRY_FAMILIES: readonly ColumnarFamily[] = [
	{
		name: EDGE_COUNTRY_METRIC_NAME,
		help: "Edge status by country and host",
		valueIndex: 0,
	},
];
const EDGE_ERROR_RATE_FAMILIES: readonly ColumnarFamily[] = [
	{
		name: EDGE_COUNTRY_ERROR_RATE_METRIC_NAME,
		help: "Edge error rate (4xx+5xx / total)",
		type: "gauge",
		valueIndex: 0,
	},
];

function toColumnarZones(
	zones: readonly PackedEdgeCountryZone[],
): ColumnarZoneRows[] {
	return zones.map((zone) => ({
		zone: zone.zone,
		rows: zone.edgeStatus.map((edgeStatus, index) => ({
			keys: [edgeStatus, zone.country[index] ?? "", zone.host[index] ?? ""],
			values: [zone.count[index] ?? 0],
			misses: zone.misses[index] ?? 0,
			lastIngest: zone.lastIngest[index] ?? 0,
		})),
	}));
}

function zoneStats(metrics: readonly MetricDefinition[]) {
	const stats = new Map<string, { total: number; errors: number }>();
	for (const value of metrics.find(
		(metric) => metric.name === EDGE_COUNTRY_METRIC_NAME,
	)?.values ?? []) {
		const zone = value.labels.zone ?? "";
		const current = stats.get(zone) ?? { total: 0, errors: 0 };
		current.total += value.value;
		if (Number(value.labels.edge_status) >= 400) current.errors += value.value;
		stats.set(zone, current);
	}
	return stats;
}

export function accumulatePackedEdgeCountryRows(
	previous: PackedEdgeCountryMetricState | undefined,
	metrics: readonly MetricDefinition[],
	ingestId: number,
	failedScopes: ReadonlySet<string>,
): PackedEdgeCountryZone[] {
	const stats = zoneStats(metrics);
	const zones = accumulateColumnarZones(
		toColumnarZones(previous?.zones ?? []),
		observeColumnarWindow(
			metrics,
			EDGE_COUNTRY_FAMILIES,
			EDGE_COUNTRY_KEY_LABELS,
			1,
		),
		ingestId,
		previous?.lastIngest !== ingestId,
		failedScopes,
	);
	return zones.map((bucket) => {
		const previousZone = previous?.zones.find(
			(zone) => zone.zone === bucket.zone,
		);
		const currentStats = failedScopes.has(bucket.zone)
			? previousZone
			: stats.get(bucket.zone);
		return {
			zone: bucket.zone,
			edgeStatus: bucket.rows.map((row) => row.keys[0] ?? ""),
			country: bucket.rows.map((row) => row.keys[1] ?? ""),
			host: bucket.rows.map((row) => row.keys[2] ?? ""),
			count: bucket.rows.map((row) => row.values[0] ?? 0),
			misses: bucket.rows.map((row) => row.misses),
			lastIngest: bucket.rows.map((row) => row.lastIngest),
			total: currentStats?.total ?? 0,
			errors: currentStats?.errors ?? 0,
		};
	});
}

function edgeCountrySamples(states: readonly PackedEdgeCountryMetricState[]) {
	return function* samples() {
		for (const state of states) {
			for (const zone of state.zones) {
				for (let index = 0; index < zone.edgeStatus.length; index++) {
					yield {
						zone: zone.zone,
						keys: [
							zone.edgeStatus[index] ?? "",
							zone.country[index] ?? "",
							zone.host[index] ?? "",
						],
						value: zone.count[index] ?? 0,
					};
				}
			}
		}
	};
}

function edgeErrorRateSamples(states: readonly PackedEdgeCountryMetricState[]) {
	return function* samples() {
		for (const state of states) {
			for (const zone of state.zones) {
				if (zone.total > 0) {
					yield { zone: zone.zone, keys: [], value: zone.errors / zone.total };
				}
			}
		}
	};
}

export function* serializePackedEdgeCountryMetrics(
	states: readonly PackedEdgeCountryMetricState[],
	options: SerializeOptions,
): Generator<string> {
	yield* serializeColumnarMetrics(
		edgeCountrySamples(states),
		EDGE_COUNTRY_FAMILIES,
		EDGE_COUNTRY_KEY_LABELS,
		options,
	);
	yield* serializeColumnarMetrics(
		edgeErrorRateSamples(states),
		EDGE_ERROR_RATE_FAMILIES,
		[],
		options,
	);
}
