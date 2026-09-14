import { z } from "zod";
import type { MetricDefinition } from "./metrics";
import {
	accumulateColumnarZones,
	type ColumnarFamily,
	type ColumnarZoneRows,
	observeColumnarWindow,
} from "./packed-columnar-state";

/** Query name whose counters use the packed colo storage format. */
export const COLO_METRICS_QUERY_NAME = "colo-metrics";

/**
 * Columnar counters for one zone: row `i` is `colo[i]`, `host[i]`, ... .
 * Storing columns instead of objects removes per-row key names, keeping 150k
 * unique zone/colo/host rows under the 16 MiB state guard and 32 MiB RPC cap.
 */
const PackedColoZoneSchema = z
	.object({
		zone: z.string(),
		colo: z.array(z.string()),
		host: z.array(z.string()),
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
				zone.visits,
				zone.edgeResponseBytes,
				zone.requests,
				zone.misses,
				zone.lastIngest,
			].every((column) => column.length === zone.colo.length),
		{ message: "Packed colo zone columns must have equal length" },
	);

export const PackedColoMetricStateSchema = z.object({
	format: z.literal("colo-packed-by-zone-v2"),
	accountId: z.string(),
	accountName: z.string(),
	queryName: z.literal(COLO_METRICS_QUERY_NAME),
	lastFetch: z.number(),
	lastIngest: z.number(),
	zones: z.array(PackedColoZoneSchema),
});

export type PackedColoZone = z.infer<typeof PackedColoZoneSchema>;
export type PackedColoMetricState = z.infer<typeof PackedColoMetricStateSchema>;

/** Packed value column exported by each Prometheus family. */
export type PackedColoValueColumn = "visits" | "edgeResponseBytes" | "requests";

/** Value columns in value-slot order, as read by the sample source. */
const COLO_VALUE_COLUMNS: readonly PackedColoValueColumn[] = [
	"visits",
	"edgeResponseBytes",
	"requests",
];

/** Row key labels in export order, following the zone label. */
export const COLO_KEY_LABELS: readonly string[] = ["colo", "host"];

export const PACKED_COLO_METRIC_FAMILIES: readonly ColumnarFamily[] = [
	{
		name: "cloudflare_zone_colocation_visits_total",
		help: "Visits per colo",
		valueIndex: 0,
	},
	{
		name: "cloudflare_zone_colocation_edge_response_bytes_total",
		help: "Edge response bytes per colo",
		valueIndex: 1,
	},
	{
		name: "cloudflare_zone_colocation_requests_total",
		help: "Requests per colo",
		valueIndex: 2,
	},
];

function emptyZone(zone: string): PackedColoZone {
	return {
		zone,
		colo: [],
		host: [],
		visits: [],
		edgeResponseBytes: [],
		requests: [],
		misses: [],
		lastIngest: [],
	};
}

/** Expands packed columns into neutral rows for the shared accumulator. */
function toColumnarZones(zones: readonly PackedColoZone[]): ColumnarZoneRows[] {
	return zones.map((zone) => ({
		zone: zone.zone,
		rows: zone.colo.map((colo, index) => ({
			keys: [colo, zone.host[index] ?? ""],
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

/** Collapses neutral rows back into packed columns for storage. */
function toPackedZones(zones: readonly ColumnarZoneRows[]): PackedColoZone[] {
	return zones.map((bucket) => {
		const packed = emptyZone(bucket.zone);
		for (const row of bucket.rows) {
			packed.colo.push(row.keys[0] ?? "");
			packed.host.push(row.keys[1] ?? "");
			packed.visits.push(row.values[0] ?? 0);
			packed.edgeResponseBytes.push(row.values[1] ?? 0);
			packed.requests.push(row.values[2] ?? 0);
			packed.misses.push(row.misses);
			packed.lastIngest.push(row.lastIngest);
		}
		return packed;
	});
}

/**
 * Accumulate one query window into packed colo counters.
 * Replaying the same `ingestId` is idempotent; rows unseen for five windows expire.
 * Rows in `failedScopes` (zones whose query failed) are neither aged nor expired.
 *
 * @param previous Previously stored packed colo snapshot.
 * @param metrics Metrics returned for the current query window.
 * @param ingestId Stable identifier of the current query window.
 * @param failedScopes Zone labels whose query failed this refresh.
 * @returns Packed colo zones ready for storage.
 */
export function accumulatePackedColoRows(
	previous: PackedColoMetricState | undefined,
	metrics: readonly MetricDefinition[],
	ingestId: number,
	failedScopes: ReadonlySet<string>,
): PackedColoZone[] {
	return toPackedZones(
		accumulateColumnarZones(
			toColumnarZones(previous?.zones ?? []),
			observeColumnarWindow(
				metrics,
				PACKED_COLO_METRIC_FAMILIES,
				COLO_KEY_LABELS,
				COLO_VALUE_COLUMNS.length,
			),
			ingestId,
			previous?.lastIngest !== ingestId,
			failedScopes,
		),
	);
}

/** Reads packed colo columns lazily, one sample per stored row. */
export function packedColoSamples(states: readonly PackedColoMetricState[]): (
	valueIndex: number,
) => Generator<{
	zone: string;
	keys: readonly string[];
	value: number;
}> {
	return function* samples(valueIndex) {
		const column = COLO_VALUE_COLUMNS[valueIndex] ?? "visits";
		for (const state of states) {
			for (const bucket of state.zones) {
				const values = bucket[column];
				for (let index = 0; index < bucket.colo.length; index++) {
					yield {
						zone: bucket.zone,
						keys: [bucket.colo[index] ?? "", bucket.host[index] ?? ""],
						value: values[index] ?? 0,
					};
				}
			}
		}
	};
}
