import { z } from "zod";
import type { MetricDefinition } from "./metrics";
import {
	accumulateColumnarZones,
	type ColumnarFamily,
	type ColumnarZoneRows,
	observeColumnarWindow,
} from "./packed-columnar-state";

/** Query name whose counters use the packed origin status storage format. */
export const ORIGIN_STATUS_METRICS_QUERY_NAME = "origin-status-metrics";

/**
 * Columnar counters for one zone: row `i` is `originStatus[i]`, `country[i]`,
 * `host[i]`. The status is stored as the exported label string so the packed and
 * unpacked paths emit byte-identical label values.
 */
const PackedOriginStatusZoneSchema = z
	.object({
		zone: z.string(),
		originStatus: z.array(z.string()),
		country: z.array(z.string()),
		host: z.array(z.string()),
		requests: z.array(z.number()),
		misses: z.array(z.number().int().nonnegative()),
		lastIngest: z.array(z.number()),
	})
	.refine(
		(zone) =>
			[
				zone.country,
				zone.host,
				zone.requests,
				zone.misses,
				zone.lastIngest,
			].every((column) => column.length === zone.originStatus.length),
		{ message: "Packed origin status zone columns must have equal length" },
	);

export const PackedOriginStatusMetricStateSchema = z.object({
	format: z.literal("origin-status-packed-by-zone-v1"),
	accountId: z.string(),
	accountName: z.string(),
	queryName: z.literal(ORIGIN_STATUS_METRICS_QUERY_NAME),
	lastFetch: z.number(),
	lastIngest: z.number(),
	zones: z.array(PackedOriginStatusZoneSchema),
});

export type PackedOriginStatusZone = z.infer<
	typeof PackedOriginStatusZoneSchema
>;
export type PackedOriginStatusMetricState = z.infer<
	typeof PackedOriginStatusMetricStateSchema
>;

/** Row key labels in export order, following the zone label. */
export const ORIGIN_STATUS_KEY_LABELS: readonly string[] = [
	"origin_status",
	"country",
	"host",
];

/**
 * The single exported family. Its name must stay byte-identical to the
 * unpacked path in `getOriginStatusMetrics`, because the rollout flag is
 * resolved per scrape and a rename would break existing dashboards.
 */
export const PACKED_ORIGIN_STATUS_METRIC_FAMILIES: readonly ColumnarFamily[] = [
	{
		name: "cloudflare_zone_requests_origin_status_country_host_total",
		help: "Requests by origin status, country, and host",
		valueIndex: 0,
	},
];

function emptyZone(zone: string): PackedOriginStatusZone {
	return {
		zone,
		originStatus: [],
		country: [],
		host: [],
		requests: [],
		misses: [],
		lastIngest: [],
	};
}

/** Expands packed columns into neutral rows for the shared accumulator. */
function toColumnarZones(
	zones: readonly PackedOriginStatusZone[],
): ColumnarZoneRows[] {
	return zones.map((zone) => ({
		zone: zone.zone,
		rows: zone.originStatus.map((originStatus, index) => ({
			keys: [originStatus, zone.country[index] ?? "", zone.host[index] ?? ""],
			values: [zone.requests[index] ?? 0],
			misses: zone.misses[index] ?? 0,
			lastIngest: zone.lastIngest[index] ?? 0,
		})),
	}));
}

/** Collapses neutral rows back into packed columns for storage. */
function toPackedZones(
	zones: readonly ColumnarZoneRows[],
): PackedOriginStatusZone[] {
	return zones.map((bucket) => {
		const packed = emptyZone(bucket.zone);
		for (const row of bucket.rows) {
			packed.originStatus.push(row.keys[0] ?? "");
			packed.country.push(row.keys[1] ?? "");
			packed.host.push(row.keys[2] ?? "");
			packed.requests.push(row.values[0] ?? 0);
			packed.misses.push(row.misses);
			packed.lastIngest.push(row.lastIngest);
		}
		return packed;
	});
}

/**
 * Accumulate one query window into packed origin status counters.
 * Replaying the same `ingestId` is idempotent; rows unseen for five windows expire.
 * Rows in `failedScopes` (zones whose query failed) are neither aged nor expired.
 *
 * @param previous Previously stored packed origin status snapshot.
 * @param metrics Metrics returned for the current query window.
 * @param ingestId Stable identifier of the current query window.
 * @param failedScopes Zone labels whose query failed this refresh.
 * @returns Packed origin status zones ready for storage.
 */
export function accumulatePackedOriginStatusRows(
	previous: PackedOriginStatusMetricState | undefined,
	metrics: readonly MetricDefinition[],
	ingestId: number,
	failedScopes: ReadonlySet<string>,
): PackedOriginStatusZone[] {
	return toPackedZones(
		accumulateColumnarZones(
			toColumnarZones(previous?.zones ?? []),
			observeColumnarWindow(
				metrics,
				PACKED_ORIGIN_STATUS_METRIC_FAMILIES,
				ORIGIN_STATUS_KEY_LABELS,
				1,
			),
			ingestId,
			previous?.lastIngest !== ingestId,
			failedScopes,
		),
	);
}

/** Reads packed origin status columns lazily, one sample per stored row. */
export function packedOriginStatusSamples(
	states: readonly PackedOriginStatusMetricState[],
): (valueIndex: number) => Generator<{
	zone: string;
	keys: readonly string[];
	value: number;
}> {
	return function* samples() {
		for (const state of states) {
			for (const bucket of state.zones) {
				for (let index = 0; index < bucket.originStatus.length; index++) {
					yield {
						zone: bucket.zone,
						keys: [
							bucket.originStatus[index] ?? "",
							bucket.country[index] ?? "",
							bucket.host[index] ?? "",
						],
						value: bucket.requests[index] ?? 0,
					};
				}
			}
		}
	};
}
