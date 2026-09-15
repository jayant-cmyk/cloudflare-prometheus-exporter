import { z } from "zod";
import type { MetricDefinition } from "./metrics";
import {
	accumulateColumnarZones,
	type ColumnarFamily,
	type ColumnarZoneRows,
	observeColumnarWindow,
} from "./packed-columnar-state";

export const COLO_ERROR_METRICS_QUERY_NAME = "colo-error-metrics";

const PackedColoErrorZoneSchema = z
	.object({
		zone: z.string(),
		colo: z.array(z.string()),
		host: z.array(z.string()),
		status: z.array(z.string()),
		visits: z.array(z.number()),
		edgeResponseBytes: z.array(z.number()),
		requests: z.array(z.number()),
		misses: z.array(z.number().int().nonnegative()),
		lastIngest: z.array(z.number()),
	})
	.refine(
		(zone) =>
			[
				zone.host,
				zone.status,
				zone.visits,
				zone.edgeResponseBytes,
				zone.requests,
				zone.misses,
				zone.lastIngest,
			].every((column) => column.length === zone.colo.length),
		{ message: "Packed colo error zone columns must have equal length" },
	);

export const PackedColoErrorMetricStateSchema = z.object({
	format: z.literal("colo-error-packed-by-zone-v1"),
	accountId: z.string(),
	accountName: z.string(),
	queryName: z.literal(COLO_ERROR_METRICS_QUERY_NAME),
	lastFetch: z.number(),
	lastIngest: z.number(),
	zones: z.array(PackedColoErrorZoneSchema),
});

export type PackedColoErrorZone = z.infer<typeof PackedColoErrorZoneSchema>;
export type PackedColoErrorMetricState = z.infer<
	typeof PackedColoErrorMetricStateSchema
>;

type PackedColoErrorValueColumn = "visits" | "edgeResponseBytes" | "requests";

const COLO_ERROR_VALUE_COLUMNS: readonly PackedColoErrorValueColumn[] = [
	"visits",
	"edgeResponseBytes",
	"requests",
];

export const COLO_ERROR_KEY_LABELS: readonly string[] = [
	"colo",
	"host",
	"status",
];

export const PACKED_COLO_ERROR_METRIC_FAMILIES: readonly ColumnarFamily[] = [
	{
		name: "cloudflare_zone_colocation_error_visits_total",
		help: "Error visits per colo",
		valueIndex: 0,
	},
	{
		name: "cloudflare_zone_colocation_error_edge_response_bytes_total",
		help: "Error response bytes per colo",
		valueIndex: 1,
	},
	{
		name: "cloudflare_zone_colocation_error_requests_total",
		help: "Error requests per colo",
		valueIndex: 2,
	},
];

function emptyZone(zone: string): PackedColoErrorZone {
	return {
		zone,
		colo: [],
		host: [],
		status: [],
		visits: [],
		edgeResponseBytes: [],
		requests: [],
		misses: [],
		lastIngest: [],
	};
}

function toColumnarZones(
	zones: readonly PackedColoErrorZone[],
): ColumnarZoneRows[] {
	return zones.map((zone) => ({
		zone: zone.zone,
		rows: zone.colo.map((colo, index) => ({
			keys: [colo, zone.host[index] ?? "", zone.status[index] ?? ""],
			values: [
				zone.visits[index] ?? 0,
				zone.edgeResponseBytes[index] ?? 0,
				zone.requests[index] ?? 0,
			],
			misses: zone.misses[index] ?? 0,
			lastIngest: zone.lastIngest[index] ?? 0,
		})),
	}));
}

function toPackedZones(
	zones: readonly ColumnarZoneRows[],
): PackedColoErrorZone[] {
	return zones.map((bucket) => {
		const packed = emptyZone(bucket.zone);
		for (const row of bucket.rows) {
			packed.colo.push(row.keys[0] ?? "");
			packed.host.push(row.keys[1] ?? "");
			packed.status.push(row.keys[2] ?? "");
			packed.visits.push(row.values[0] ?? 0);
			packed.edgeResponseBytes.push(row.values[1] ?? 0);
			packed.requests.push(row.values[2] ?? 0);
			packed.misses.push(row.misses);
			packed.lastIngest.push(row.lastIngest);
		}
		return packed;
	});
}

export function accumulatePackedColoErrorRows(
	previous: PackedColoErrorMetricState | undefined,
	metrics: readonly MetricDefinition[],
	ingestId: number,
	failedScopes: ReadonlySet<string>,
): PackedColoErrorZone[] {
	return toPackedZones(
		accumulateColumnarZones(
			toColumnarZones(previous?.zones ?? []),
			observeColumnarWindow(
				metrics,
				PACKED_COLO_ERROR_METRIC_FAMILIES,
				COLO_ERROR_KEY_LABELS,
				COLO_ERROR_VALUE_COLUMNS.length,
			),
			ingestId,
			previous?.lastIngest !== ingestId,
			failedScopes,
		),
	);
}

export function packedColoErrorSamples(
	states: readonly PackedColoErrorMetricState[],
): (valueIndex: number) => Generator<{
	zone: string;
	keys: readonly string[];
	value: number;
}> {
	return function* samples(valueIndex) {
		const column = COLO_ERROR_VALUE_COLUMNS[valueIndex] ?? "visits";
		for (const state of states) {
			for (const bucket of state.zones) {
				const values = bucket[column];
				for (let index = 0; index < bucket.colo.length; index++) {
					yield {
						zone: bucket.zone,
						keys: [
							bucket.colo[index] ?? "",
							bucket.host[index] ?? "",
							bucket.status[index] ?? "",
						],
						value: values[index] ?? 0,
					};
				}
			}
		}
	};
}
