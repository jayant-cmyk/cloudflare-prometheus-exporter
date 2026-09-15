import { z } from "zod";

export const LOGPUSH_ZONE_METRICS_QUERY_NAME = "logpush-zone";
export const LOGPUSH_ZONE_METRIC_NAME =
	"cloudflare_logpush_failed_jobs_zone_total";
export const LOGPUSH_ZONE_METRIC_HELP = "Failed logpush jobs per zone";

const LogpushZoneRowSchema = z.object({
	jobId: z.string(),
	destinationType: z.string(),
	status: z.string().optional(),
	count: z.number(),
});

const PackedLogpushZoneSchema = z.object({
	zone: z.string(),
	rows: z.array(LogpushZoneRowSchema),
});

export const PackedLogpushZoneMetricStateSchema = z.object({
	format: z.literal("logpush-zone-packed-by-zone-v1"),
	accountId: z.string(),
	accountName: z.string(),
	queryName: z.literal(LOGPUSH_ZONE_METRICS_QUERY_NAME),
	lastFetch: z.number(),
	lastIngest: z.number(),
	zones: z.array(PackedLogpushZoneSchema),
});

export type LogpushZone = z.infer<typeof PackedLogpushZoneSchema>;
export type PackedLogpushZoneMetricState = z.infer<
	typeof PackedLogpushZoneMetricStateSchema
>;

export const LOGPUSH_ZONE_KEY_LABELS: readonly string[] = [
	"job_id",
	"destination_type",
];

/** Reads packed logpush rows lazily, one sample per stored row. */
export function packedLogpushZoneSamples(
	states: readonly PackedLogpushZoneMetricState[],
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
						keys: [row.jobId, row.destinationType],
						value: row.count,
					};
				}
			}
		}
	};
}
