import { z } from "zod";
import type { CounterObservation } from "./counters";
import type { ColumnarFamily } from "./packed-columnar-state";

export const REQUEST_METHOD_METRICS_QUERY_NAME = "request-method-metrics";
export const REQUEST_METHOD_METRIC_NAME =
	"cloudflare_zone_requests_by_method_total";
export const REQUEST_METHOD_METRIC_HELP = "Requests by HTTP method";

const RequestMethodRowSchema = z.object({
	method: z.string(),
	count: z.number(),
});

const RequestMethodZoneSchema = z.object({
	zone: z.string(),
	rows: z.array(RequestMethodRowSchema),
});

export const PackedRequestMethodMetricStateSchema = z.object({
	format: z.literal("request-method-packed-by-zone-v1"),
	accountId: z.string(),
	accountName: z.string(),
	queryName: z.literal(REQUEST_METHOD_METRICS_QUERY_NAME),
	lastFetch: z.number(),
	lastIngest: z.number(),
	zones: z.array(RequestMethodZoneSchema),
});

export type RequestMethodZone = z.infer<typeof RequestMethodZoneSchema>;
export type PackedRequestMethodMetricState = z.infer<
	typeof PackedRequestMethodMetricStateSchema
>;

export const REQUEST_METHOD_KEY_LABELS: readonly string[] = ["method"];

export const PACKED_REQUEST_METHOD_METRIC_FAMILIES: readonly ColumnarFamily[] =
	[
		{
			name: REQUEST_METHOD_METRIC_NAME,
			help: REQUEST_METHOD_METRIC_HELP,
			valueIndex: 0,
		},
	];

export function buildPackedRequestMethodZones(
	observations: readonly CounterObservation[],
): RequestMethodZone[] {
	const zones = new Map<string, RequestMethodZone["rows"]>();
	for (const observation of observations) {
		if (observation.metricName !== REQUEST_METHOD_METRIC_NAME) continue;
		const zone = observation.labels.zone ?? "";
		const rows = zones.get(zone);
		const row = {
			method: observation.labels.method ?? "",
			count: observation.value,
		};
		if (rows === undefined) {
			zones.set(zone, [row]);
		} else {
			rows.push(row);
		}
	}
	return [...zones].map(([zone, rows]) => ({ zone, rows }));
}

/** Reads packed request method rows lazily, one sample per stored row. */
export function packedRequestMethodSamples(
	states: readonly PackedRequestMethodMetricState[],
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
						keys: [row.method],
						value: row.count,
					};
				}
			}
		}
	};
}
