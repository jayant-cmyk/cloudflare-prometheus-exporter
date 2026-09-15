import { z } from "zod";
import type { ColumnarFamily } from "./packed-columnar-state";

export const CACHE_MISS_METRICS_QUERY_NAME = "cache-miss-metrics";
export const CACHE_MISS_METRIC_NAME =
	"cloudflare_zone_cache_miss_origin_duration_seconds";
export const CACHE_MISS_METRIC_HELP =
	"Average origin response duration on cache miss in seconds";

const CacheMissRowSchema = z.object({
	country: z.string(),
	host: z.string(),
	avgOriginDurationMs: z.number(),
});

const CacheMissZoneSchema = z.object({
	zone: z.string(),
	rows: z.array(CacheMissRowSchema),
});

export const PackedCacheMissMetricStateSchema = z.object({
	format: z.literal("cache-miss-packed-by-zone-v1"),
	accountId: z.string(),
	accountName: z.string(),
	queryName: z.literal(CACHE_MISS_METRICS_QUERY_NAME),
	lastFetch: z.number(),
	lastIngest: z.number(),
	zones: z.array(CacheMissZoneSchema),
});

export type CacheMissZone = z.infer<typeof CacheMissZoneSchema>;
export type PackedCacheMissMetricState = z.infer<
	typeof PackedCacheMissMetricStateSchema
>;

export const CACHE_MISS_KEY_LABELS: readonly string[] = ["country", "host"];

export const PACKED_CACHE_MISS_METRIC_FAMILIES: readonly ColumnarFamily[] = [
	{
		name: CACHE_MISS_METRIC_NAME,
		help: CACHE_MISS_METRIC_HELP,
		type: "gauge",
		valueIndex: 0,
	},
];

/** Reads packed cache miss rows lazily. */
export function packedCacheMissSamples(
	states: readonly PackedCacheMissMetricState[],
): (valueIndex: number) => Generator<{
	zone: string;
	keys: readonly string[];
	value: number;
}> {
	return function* samples() {
		for (const state of states) {
			for (const bucket of state.zones) {
				for (const row of bucket.rows) {
					yield {
						zone: bucket.zone,
						keys: [row.country, row.host],
						value: row.avgOriginDurationMs / 1000,
					};
				}
			}
		}
	};
}
