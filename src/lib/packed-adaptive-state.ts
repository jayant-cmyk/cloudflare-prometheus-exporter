import { z } from "zod";
import type { CounterObservation } from "./counters";
import type { ColumnarSampleSource } from "./packed-columnar-prometheus";

export const ADAPTIVE_METRICS_QUERY_NAME = "adaptive-metrics";
export const ADAPTIVE_4XX_METRIC_NAME =
	"cloudflare_zone_customer_error_4xx_total";
export const ADAPTIVE_4XX_METRIC_HELP = "4xx error requests";
export const ADAPTIVE_5XX_METRIC_NAME =
	"cloudflare_zone_customer_error_5xx_total";
export const ADAPTIVE_5XX_METRIC_HELP = "5xx error requests";
export const ADAPTIVE_DURATION_METRIC_NAME =
	"cloudflare_zone_origin_response_duration_seconds";
export const ADAPTIVE_DURATION_METRIC_HELP =
	"Origin response duration in seconds";
export const ADAPTIVE_RATE_METRIC_NAME = "cloudflare_zone_origin_error_rate";
export const ADAPTIVE_RATE_METRIC_HELP =
	"Origin error rate (4xx+5xx / total origin errors)";

const AdaptiveRowSchema = z.object({
	status: z.string(),
	country: z.string(),
	host: z.string(),
	count: z.number(),
	avgOriginDurationMs: z.number().nullable(),
});

const PackedAdaptiveZoneSchema = z
	.object({
		zone: z.string(),
		status: z.array(z.string()),
		country: z.array(z.string()),
		host: z.array(z.string()),
		count: z.array(z.number()),
		avgOriginDurationMs: z.array(z.number().nullable()),
		errors4xx: z.number(),
		errors5xx: z.number(),
	})
	.refine(
		(zone) =>
			[zone.country, zone.host, zone.count, zone.avgOriginDurationMs].every(
				(column) => column.length === zone.status.length,
			),
		{ message: "Packed adaptive zone columns must have equal length" },
	);

export const PackedAdaptiveMetricStateSchema = z.object({
	format: z.literal("adaptive-packed-by-zone-v1"),
	accountId: z.string(),
	accountName: z.string(),
	queryName: z.literal(ADAPTIVE_METRICS_QUERY_NAME),
	lastFetch: z.number(),
	lastIngest: z.number(),
	zones: z.array(PackedAdaptiveZoneSchema),
});

export type AdaptiveZone = {
	zone: string;
	rows: z.infer<typeof AdaptiveRowSchema>[];
	errors4xx: number;
	errors5xx: number;
};

export type PackedAdaptiveZone = z.infer<typeof PackedAdaptiveZoneSchema>;
export type PackedAdaptiveMetricState = z.infer<
	typeof PackedAdaptiveMetricStateSchema
>;

export const ADAPTIVE_KEY_LABELS: readonly string[] = [
	"status",
	"country",
	"host",
];

function emptyZone(
	zone: string,
	errors4xx: number,
	errors5xx: number,
): PackedAdaptiveZone {
	return {
		zone,
		status: [],
		country: [],
		host: [],
		count: [],
		avgOriginDurationMs: [],
		errors4xx,
		errors5xx,
	};
}

function adaptiveMetricName(status: string): string | undefined {
	const statusCode = Number(status);
	if (statusCode >= 400 && statusCode < 500) {
		return ADAPTIVE_4XX_METRIC_NAME;
	}
	if (statusCode >= 500) {
		return ADAPTIVE_5XX_METRIC_NAME;
	}
	return undefined;
}

function adaptiveRowKey(
	zone: string,
	status: string,
	country: string,
	host: string,
) {
	return `${zone}\x00${status}\x00${country}\x00${host}`;
}

export function buildPackedAdaptiveZones(
	observations: readonly CounterObservation[],
	zones: readonly AdaptiveZone[],
): PackedAdaptiveZone[] {
	const counts = new Map<string, number>();
	for (const observation of observations) {
		if (
			observation.metricName !== ADAPTIVE_4XX_METRIC_NAME &&
			observation.metricName !== ADAPTIVE_5XX_METRIC_NAME
		) {
			continue;
		}
		counts.set(
			adaptiveRowKey(
				observation.labels.zone ?? "",
				observation.labels.status ?? "",
				observation.labels.country ?? "",
				observation.labels.host ?? "",
			),
			observation.value,
		);
	}

	return zones.map((zone) => {
		const packed = emptyZone(zone.zone, zone.errors4xx, zone.errors5xx);
		for (const row of zone.rows) {
			packed.status.push(row.status);
			packed.country.push(row.country);
			packed.host.push(row.host);
			packed.count.push(
				counts.get(
					adaptiveRowKey(zone.zone, row.status, row.country, row.host),
				) ?? 0,
			);
			packed.avgOriginDurationMs.push(row.avgOriginDurationMs);
		}
		return packed;
	});
}

export function adaptiveCounterObservations(
	zones: readonly AdaptiveZone[],
): CounterObservation[] {
	return zones.flatMap((zone) =>
		zone.rows.flatMap((row) => {
			if (row.count <= 0) {
				return [];
			}
			const metricName = adaptiveMetricName(row.status);
			if (metricName === undefined) {
				return [];
			}
			return [
				{
					metricName,
					labels: {
						zone: zone.zone,
						status: row.status,
						country: row.country,
						host: row.host,
					},
					value: row.count,
				},
			];
		}),
	);
}

export function packedAdaptiveSamples(
	states: readonly PackedAdaptiveMetricState[],
): ColumnarSampleSource {
	return function* samples(valueIndex) {
		for (const state of states) {
			for (const bucket of state.zones) {
				for (let index = 0; index < bucket.status.length; index++) {
					const status = bucket.status[index] ?? "";
					const count = bucket.count[index] ?? 0;
					if (valueIndex === 0) {
						if (Number(status) >= 400 && Number(status) < 500 && count > 0) {
							yield {
								zone: bucket.zone,
								keys: [
									status,
									bucket.country[index] ?? "",
									bucket.host[index] ?? "",
								],
								value: count,
							};
						}
						continue;
					}
					if (valueIndex === 1) {
						if (Number(status) >= 500 && count > 0) {
							yield {
								zone: bucket.zone,
								keys: [
									status,
									bucket.country[index] ?? "",
									bucket.host[index] ?? "",
								],
								value: count,
							};
						}
						continue;
					}
					const avgDuration = bucket.avgOriginDurationMs[index];
					if (avgDuration != null) {
						yield {
							zone: bucket.zone,
							keys: [
								status,
								bucket.country[index] ?? "",
								bucket.host[index] ?? "",
							],
							value: avgDuration / 1000,
						};
					}
				}
			}
		}
	};
}

export function packedAdaptiveRateSamples(
	states: readonly PackedAdaptiveMetricState[],
): ColumnarSampleSource {
	return function* samples() {
		for (const state of states) {
			for (const bucket of state.zones) {
				const totalErrors = bucket.errors4xx + bucket.errors5xx;
				if (totalErrors <= 0) {
					continue;
				}
				yield {
					zone: bucket.zone,
					keys: [],
					value: bucket.errors5xx / totalErrors,
				};
			}
		}
	};
}
