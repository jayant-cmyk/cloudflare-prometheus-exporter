import { z } from "zod";

export const LB_WEIGHT_METRICS_QUERY_NAME = "lb-weight-metrics";
export const LB_WEIGHT_METRIC_NAME = "cloudflare_zone_lb_origin_weight";
export const LB_WEIGHT_METRIC_HELP =
	"Load balancer origin weight (0-1 normalized)";

const LbWeightRowSchema = z.object({
	lbName: z.string(),
	poolName: z.string(),
	originName: z.string(),
	weight: z.number(),
});

const PackedLbWeightZoneSchema = z.object({
	zone: z.string(),
	rows: z.array(LbWeightRowSchema),
});

export const PackedLbWeightMetricStateSchema = z.object({
	format: z.literal("lb-weight-packed-by-zone-v1"),
	accountId: z.string(),
	accountName: z.string(),
	queryName: z.literal(LB_WEIGHT_METRICS_QUERY_NAME),
	lastFetch: z.number(),
	lastIngest: z.number(),
	zones: z.array(PackedLbWeightZoneSchema),
});

export type LbWeightZone = z.infer<typeof PackedLbWeightZoneSchema>;
export type PackedLbWeightMetricState = z.infer<
	typeof PackedLbWeightMetricStateSchema
>;

export const LB_WEIGHT_KEY_LABELS: readonly string[] = [
	"lb_name",
	"pool_name",
	"origin_name",
];

/** Reads packed LB weight rows lazily, one sample per stored row. */
export function packedLbWeightSamples(
	states: readonly PackedLbWeightMetricState[],
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
						keys: [row.lbName, row.poolName, row.originName],
						value: row.weight,
					};
				}
			}
		}
	};
}
