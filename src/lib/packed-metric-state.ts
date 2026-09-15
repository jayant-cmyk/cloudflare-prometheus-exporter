import { z } from "zod";
import { accumulateCounterMetrics } from "./counters";
import type { MetricDefinition } from "./metrics";
import {
	ADAPTIVE_4XX_METRIC_NAME,
	ADAPTIVE_5XX_METRIC_NAME,
	ADAPTIVE_DURATION_METRIC_NAME,
	ADAPTIVE_METRICS_QUERY_NAME,
	type PackedAdaptiveMetricState,
	PackedAdaptiveMetricStateSchema,
	type PackedAdaptiveZone,
} from "./packed-adaptive-state";
import {
	CACHE_MISS_METRIC_NAME,
	CACHE_MISS_METRICS_QUERY_NAME,
	type CacheMissZone,
	type PackedCacheMissMetricState,
	PackedCacheMissMetricStateSchema,
} from "./packed-cache-miss-state";
import {
	accumulatePackedColoErrorRows,
	COLO_ERROR_METRICS_QUERY_NAME,
	PackedColoErrorMetricStateSchema,
} from "./packed-colo-error-state";
import {
	accumulatePackedColoRows,
	COLO_METRICS_QUERY_NAME,
	PackedColoMetricStateSchema,
} from "./packed-colo-state";
import {
	accumulatePackedEdgeCountryRows,
	EDGE_COUNTRY_METRICS_QUERY_NAME,
	PackedEdgeCountryMetricStateSchema,
} from "./packed-edge-country";
import {
	accumulatePackedHealthCheckRows,
	HEALTH_CHECK_METRICS_QUERY_NAME,
	PackedHealthCheckMetricStateSchema,
} from "./packed-health-check";
import {
	buildPackedHostnameHttpZones,
	HOSTNAME_HTTP_METRICS_QUERY_NAME,
	PackedHostnameHttpMetricStateSchema,
} from "./packed-hostname-http";
import {
	LB_WEIGHT_METRIC_NAME,
	LB_WEIGHT_METRICS_QUERY_NAME,
	type LbWeightZone,
	type PackedLbWeightMetricState,
	PackedLbWeightMetricStateSchema,
} from "./packed-lb-weight-state";
import {
	accumulatePackedLoadBalancerRows,
	LOAD_BALANCER_METRICS_QUERY_NAME,
	PackedLoadBalancerMetricStateSchema,
} from "./packed-load-balancer";
import {
	LOGPUSH_ZONE_METRIC_NAME,
	LOGPUSH_ZONE_METRICS_QUERY_NAME,
	type LogpushZone,
	type PackedLogpushZoneMetricState,
	PackedLogpushZoneMetricStateSchema,
} from "./packed-logpush-zone-state";
import {
	accumulatePackedOriginStatusRows,
	ORIGIN_STATUS_METRICS_QUERY_NAME,
	PackedOriginStatusMetricStateSchema,
} from "./packed-origin-status-state";
import {
	type PackedRequestMethodMetricState,
	PackedRequestMethodMetricStateSchema,
	REQUEST_METHOD_METRIC_NAME,
	REQUEST_METHOD_METRICS_QUERY_NAME,
	type RequestMethodZone,
} from "./packed-request-method-state";
import {
	type PackedSSLCertificateMetricState,
	PackedSSLCertificateMetricStateSchema,
	SSL_CERTIFICATES_METRIC_NAME,
	SSL_CERTIFICATES_QUERY_NAME,
	type SSLCertificateZone,
} from "./packed-ssl-certificates-state";
import type { CounterState } from "./types";

export const PACKED_METRIC_QUERIES = [
	ADAPTIVE_METRICS_QUERY_NAME,
	CACHE_MISS_METRICS_QUERY_NAME,
	COLO_ERROR_METRICS_QUERY_NAME,
	COLO_METRICS_QUERY_NAME,
	EDGE_COUNTRY_METRICS_QUERY_NAME,
	HEALTH_CHECK_METRICS_QUERY_NAME,
	HOSTNAME_HTTP_METRICS_QUERY_NAME,
	LOAD_BALANCER_METRICS_QUERY_NAME,
	LB_WEIGHT_METRICS_QUERY_NAME,
	LOGPUSH_ZONE_METRICS_QUERY_NAME,
	ORIGIN_STATUS_METRICS_QUERY_NAME,
	REQUEST_METHOD_METRICS_QUERY_NAME,
	SSL_CERTIFICATES_QUERY_NAME,
] as const;
export type PackedMetricQuery = (typeof PACKED_METRIC_QUERIES)[number];

// Each query has its own MetricExporter Durable Object, so compact states can
// retain the original colo key without colliding.
export const PACKED_METRIC_STATE_KEY = "packed-colo-metrics";

export const PackedMetricStateSchema = z.discriminatedUnion("queryName", [
	PackedAdaptiveMetricStateSchema,
	PackedCacheMissMetricStateSchema,
	PackedColoErrorMetricStateSchema,
	PackedColoMetricStateSchema,
	PackedEdgeCountryMetricStateSchema,
	PackedHealthCheckMetricStateSchema,
	PackedHostnameHttpMetricStateSchema,
	PackedLoadBalancerMetricStateSchema,
	PackedLbWeightMetricStateSchema,
	PackedLogpushZoneMetricStateSchema,
	PackedOriginStatusMetricStateSchema,
	PackedRequestMethodMetricStateSchema,
	PackedSSLCertificateMetricStateSchema,
]);
export type PackedMetricState = z.infer<typeof PackedMetricStateSchema>;

export function isPackedMetricQuery(query: string): query is PackedMetricQuery {
	return (PACKED_METRIC_QUERIES as readonly string[]).includes(query);
}

export function packedMetricStateKey(_query: PackedMetricQuery): string {
	return PACKED_METRIC_STATE_KEY;
}

export function packedMetricStorageEnabled(
	_query: PackedMetricQuery,
	config: { packedMetricStorage: boolean },
): boolean {
	return config.packedMetricStorage;
}

export function packedMetricScopes(state: PackedMetricState): string[] {
	switch (state.queryName) {
		case ADAPTIVE_METRICS_QUERY_NAME:
			return state.zones
				.filter((zone) => zone.status.length > 0)
				.map((zone) => zone.zone);
		case CACHE_MISS_METRICS_QUERY_NAME:
			return state.zones
				.filter((zone) => zone.rows.length > 0)
				.map((zone) => zone.zone);
		case LB_WEIGHT_METRICS_QUERY_NAME:
		case LOGPUSH_ZONE_METRICS_QUERY_NAME:
		case REQUEST_METHOD_METRICS_QUERY_NAME:
		case SSL_CERTIFICATES_QUERY_NAME:
			return state.zones
				.filter((zone) => zone.rows.length > 0)
				.map((zone) => zone.zone);
		case EDGE_COUNTRY_METRICS_QUERY_NAME:
			return state.zones
				.filter((zone) => zone.edgeStatus.length > 0)
				.map((zone) => zone.zone);
		case HEALTH_CHECK_METRICS_QUERY_NAME:
			return state.zones
				.filter(
					(zone) => zone.eventRows.length > 0 || zone.timingRows.length > 0,
				)
				.map((zone) => zone.zone);
		case HOSTNAME_HTTP_METRICS_QUERY_NAME:
			return state.zones
				.filter(
					(zone) =>
						zone.requestRows.length > 0 ||
						zone.statusRows.length > 0 ||
						zone.cacheRows.length > 0 ||
						zone.latencyRows.length > 0,
				)
				.map((zone) => zone.zone);
		case LOAD_BALANCER_METRICS_QUERY_NAME:
			return state.zones
				.filter(
					(zone) =>
						zone.requestRows.length > 0 ||
						zone.rttRows.length > 0 ||
						zone.originsSelectedRows.length > 0 ||
						zone.policyRows.length > 0 ||
						zone.poolHealthRows.length > 0,
				)
				.map((zone) => zone.zone);
		default:
			return state.zones
				.filter((zone) => zone.misses.length > 0)
				.map((zone) => zone.zone);
	}
}

type AccumulatePackedMetricStateInput = {
	queryName: PackedMetricQuery;
	accountId: string;
	accountName: string;
	previous: PackedMetricState | undefined;
	metrics: MetricDefinition[];
	counters?: Record<string, CounterState>;
	lastIngest?: number;
	ingestId: number;
	failedScopes: ReadonlySet<string>;
};

type AccumulatedPackedMetricState = {
	state: PackedMetricState;
	counters: Record<string, CounterState>;
};

function metricValues(metrics: readonly MetricDefinition[], name: string) {
	return metrics.find((metric) => metric.name === name)?.values ?? [];
}

function preserveFailedZones<T extends { zone: string }>(
	zones: readonly T[],
	previous: readonly T[],
	failedScopes: ReadonlySet<string>,
): T[] {
	const next = new Map(zones.map((zone) => [zone.zone, zone]));
	for (const zone of previous) {
		if (failedScopes.has(zone.zone)) next.set(zone.zone, zone);
	}
	return [...next.values()];
}

function accumulateCounters(input: AccumulatePackedMetricStateInput) {
	return accumulateCounterMetrics(
		input.metrics,
		input.previous?.queryName === input.queryName ? (input.counters ?? {}) : {},
		{
			ingestId: input.ingestId,
			ageMissingCounters: input.lastIngest !== input.ingestId,
			failedScopes: input.failedScopes,
		},
	);
}

function packAdaptive(
	input: AccumulatePackedMetricStateInput,
): AccumulatedPackedMetricState {
	const previous =
		input.previous?.queryName === ADAPTIVE_METRICS_QUERY_NAME
			? input.previous
			: undefined;
	const accumulated = accumulateCounters(input);
	const zones = new Map<
		string,
		{ packed: PackedAdaptiveZone; indexes: Map<string, number> }
	>();
	const zoneFor = (zone: string) => {
		const existing = zones.get(zone);
		if (existing !== undefined) return existing;
		const created = {
			packed: {
				zone,
				status: [],
				country: [],
				host: [],
				count: [],
				avgOriginDurationMs: [],
				errors4xx: 0,
				errors5xx: 0,
			},
			indexes: new Map<string, number>(),
		};
		zones.set(zone, created);
		return created;
	};
	const rowFor = (labels: Record<string, string>) => {
		const zone = zoneFor(labels.zone ?? "");
		const status = labels.status ?? "";
		const country = labels.country ?? "";
		const host = labels.host ?? "";
		const key = `${status}\x00${country}\x00${host}`;
		const existing = zone.indexes.get(key);
		if (existing !== undefined) return { zone: zone.packed, index: existing };
		const index = zone.packed.status.length;
		zone.indexes.set(key, index);
		zone.packed.status.push(status);
		zone.packed.country.push(country);
		zone.packed.host.push(host);
		zone.packed.count.push(0);
		zone.packed.avgOriginDurationMs.push(null);
		return { zone: zone.packed, index };
	};
	for (const name of [ADAPTIVE_4XX_METRIC_NAME, ADAPTIVE_5XX_METRIC_NAME]) {
		for (const value of metricValues(accumulated.metrics, name)) {
			const row = rowFor(value.labels);
			row.zone.count[row.index] = value.value;
		}
	}
	for (const value of metricValues(
		accumulated.metrics,
		ADAPTIVE_DURATION_METRIC_NAME,
	)) {
		const row = rowFor(value.labels);
		row.zone.avgOriginDurationMs[row.index] = value.value * 1000;
	}
	for (const value of metricValues(input.metrics, ADAPTIVE_4XX_METRIC_NAME)) {
		zoneFor(value.labels.zone ?? "").packed.errors4xx += value.value;
	}
	for (const value of metricValues(input.metrics, ADAPTIVE_5XX_METRIC_NAME)) {
		zoneFor(value.labels.zone ?? "").packed.errors5xx += value.value;
	}
	const state: PackedAdaptiveMetricState = {
		format: "adaptive-packed-by-zone-v1",
		accountId: input.accountId,
		accountName: input.accountName,
		queryName: ADAPTIVE_METRICS_QUERY_NAME,
		lastFetch: Date.now(),
		lastIngest: input.ingestId,
		zones: preserveFailedZones(
			[...zones.values()].map((zone) => zone.packed),
			previous?.zones ?? [],
			input.failedScopes,
		),
	};
	return { state, counters: accumulated.counters };
}

function packRequestMethods(
	input: AccumulatePackedMetricStateInput,
): AccumulatedPackedMetricState {
	const previous =
		input.previous?.queryName === REQUEST_METHOD_METRICS_QUERY_NAME
			? input.previous
			: undefined;
	const accumulated = accumulateCounters(input);
	const zones = new Map<string, RequestMethodZone["rows"]>();
	for (const value of metricValues(
		accumulated.metrics,
		REQUEST_METHOD_METRIC_NAME,
	)) {
		const zone = value.labels.zone ?? "";
		const rows = zones.get(zone) ?? [];
		rows.push({ method: value.labels.method ?? "", count: value.value });
		zones.set(zone, rows);
	}
	const state: PackedRequestMethodMetricState = {
		format: "request-method-packed-by-zone-v1",
		accountId: input.accountId,
		accountName: input.accountName,
		queryName: REQUEST_METHOD_METRICS_QUERY_NAME,
		lastFetch: Date.now(),
		lastIngest: input.ingestId,
		zones: preserveFailedZones(
			[...zones].map(([zone, rows]) => ({ zone, rows })),
			previous?.zones ?? [],
			input.failedScopes,
		),
	};
	return { state, counters: accumulated.counters };
}

function packLogpushZone(
	input: AccumulatePackedMetricStateInput,
): AccumulatedPackedMetricState {
	const previous =
		input.previous?.queryName === LOGPUSH_ZONE_METRICS_QUERY_NAME
			? input.previous
			: undefined;
	const accumulated = accumulateCounters(input);
	const zones = new Map<string, LogpushZone["rows"]>();
	for (const value of metricValues(
		accumulated.metrics,
		LOGPUSH_ZONE_METRIC_NAME,
	)) {
		const zone = value.labels.zone ?? "";
		const rows = zones.get(zone) ?? [];
		rows.push({
			jobId: value.labels.job_id ?? "",
			destinationType: value.labels.destination_type ?? "",
			count: value.value,
		});
		zones.set(zone, rows);
	}
	const state: PackedLogpushZoneMetricState = {
		format: "logpush-zone-packed-by-zone-v1",
		accountId: input.accountId,
		accountName: input.accountName,
		queryName: LOGPUSH_ZONE_METRICS_QUERY_NAME,
		lastFetch: Date.now(),
		lastIngest: input.ingestId,
		zones: preserveFailedZones(
			[...zones].map(([zone, rows]) => ({ zone, rows })),
			previous?.zones ?? [],
			input.failedScopes,
		),
	};
	return { state, counters: accumulated.counters };
}

function packCacheMiss(input: AccumulatePackedMetricStateInput) {
	const previous =
		input.previous?.queryName === CACHE_MISS_METRICS_QUERY_NAME
			? input.previous
			: undefined;
	const zones = new Map<string, CacheMissZone["rows"]>();
	for (const value of metricValues(input.metrics, CACHE_MISS_METRIC_NAME)) {
		const zone = value.labels.zone ?? "";
		const rows = zones.get(zone) ?? [];
		rows.push({
			country: value.labels.country ?? "",
			host: value.labels.host ?? "",
			avgOriginDurationMs: value.value * 1000,
		});
		zones.set(zone, rows);
	}
	const state: PackedCacheMissMetricState = {
		format: "cache-miss-packed-by-zone-v1",
		accountId: input.accountId,
		accountName: input.accountName,
		queryName: CACHE_MISS_METRICS_QUERY_NAME,
		lastFetch: Date.now(),
		lastIngest: input.ingestId,
		zones: preserveFailedZones(
			[...zones].map(([zone, rows]) => ({ zone, rows })),
			previous?.zones ?? [],
			input.failedScopes,
		),
	};
	return state;
}

function packLbWeights(input: AccumulatePackedMetricStateInput) {
	const previous =
		input.previous?.queryName === LB_WEIGHT_METRICS_QUERY_NAME
			? input.previous
			: undefined;
	const zones = new Map<string, LbWeightZone["rows"]>();
	for (const value of metricValues(input.metrics, LB_WEIGHT_METRIC_NAME)) {
		const zone = value.labels.zone ?? "";
		const rows = zones.get(zone) ?? [];
		rows.push({
			lbName: value.labels.lb_name ?? "",
			poolName: value.labels.pool_name ?? "",
			originName: value.labels.origin_name ?? "",
			weight: value.value,
		});
		zones.set(zone, rows);
	}
	const state: PackedLbWeightMetricState = {
		format: "lb-weight-packed-by-zone-v1",
		accountId: input.accountId,
		accountName: input.accountName,
		queryName: LB_WEIGHT_METRICS_QUERY_NAME,
		lastFetch: Date.now(),
		lastIngest: input.ingestId,
		zones: preserveFailedZones(
			[...zones].map(([zone, rows]) => ({ zone, rows })),
			previous?.zones ?? [],
			input.failedScopes,
		),
	};
	return state;
}

function packSslCertificates(input: AccumulatePackedMetricStateInput) {
	const previous =
		input.previous?.queryName === SSL_CERTIFICATES_QUERY_NAME
			? input.previous
			: undefined;
	const zones = new Map<string, SSLCertificateZone["rows"]>();
	for (const value of metricValues(
		input.metrics,
		SSL_CERTIFICATES_METRIC_NAME,
	)) {
		const zone = value.labels.zone ?? "";
		const rows = zones.get(zone) ?? [];
		rows.push({
			type: value.labels.type ?? "",
			issuer: value.labels.issuer ?? "",
			status: value.labels.status ?? "",
			expiresOnSeconds: value.value,
		});
		zones.set(zone, rows);
	}
	const state: PackedSSLCertificateMetricState = {
		format: "ssl-certificates-packed-by-zone-v1",
		accountId: input.accountId,
		accountName: input.accountName,
		queryName: SSL_CERTIFICATES_QUERY_NAME,
		lastFetch: Date.now(),
		lastIngest: input.ingestId,
		zones: preserveFailedZones(
			[...zones].map(([zone, rows]) => ({ zone, rows })),
			previous?.zones ?? [],
			input.failedScopes,
		),
	};
	return state;
}

export function accumulatePackedMetricStateWithCounters(
	input: AccumulatePackedMetricStateInput,
): AccumulatedPackedMetricState {
	const envelope = {
		accountId: input.accountId,
		accountName: input.accountName,
		lastFetch: Date.now(),
		lastIngest: input.ingestId,
	};
	const noCounters: Record<string, CounterState> = {};

	switch (input.queryName) {
		case ADAPTIVE_METRICS_QUERY_NAME:
			return packAdaptive(input);
		case CACHE_MISS_METRICS_QUERY_NAME:
			return { state: packCacheMiss(input), counters: noCounters };
		case COLO_ERROR_METRICS_QUERY_NAME:
			return {
				state: {
					...envelope,
					format: "colo-error-packed-by-zone-v1",
					queryName: COLO_ERROR_METRICS_QUERY_NAME,
					zones: accumulatePackedColoErrorRows(
						input.previous?.queryName === COLO_ERROR_METRICS_QUERY_NAME
							? input.previous
							: undefined,
						input.metrics,
						input.ingestId,
						input.failedScopes,
					),
				},
				counters: noCounters,
			};
		case COLO_METRICS_QUERY_NAME:
			return {
				state: {
					...envelope,
					format: "colo-packed-by-zone-v2",
					queryName: COLO_METRICS_QUERY_NAME,
					zones: accumulatePackedColoRows(
						input.previous?.queryName === COLO_METRICS_QUERY_NAME
							? input.previous
							: undefined,
						input.metrics,
						input.ingestId,
						input.failedScopes,
					),
				},
				counters: noCounters,
			};
		case EDGE_COUNTRY_METRICS_QUERY_NAME:
			return {
				state: {
					...envelope,
					format: "edge-country-packed-by-zone-v1",
					queryName: EDGE_COUNTRY_METRICS_QUERY_NAME,
					zones: accumulatePackedEdgeCountryRows(
						input.previous?.queryName === EDGE_COUNTRY_METRICS_QUERY_NAME
							? input.previous
							: undefined,
						input.metrics,
						input.ingestId,
						input.failedScopes,
					),
				},
				counters: noCounters,
			};
		case HEALTH_CHECK_METRICS_QUERY_NAME:
			return {
				state: {
					...envelope,
					format: "health-check-packed-by-zone-v1",
					queryName: HEALTH_CHECK_METRICS_QUERY_NAME,
					zones: accumulatePackedHealthCheckRows(
						input.previous?.queryName === HEALTH_CHECK_METRICS_QUERY_NAME
							? input.previous
							: undefined,
						input.metrics,
						input.ingestId,
						input.failedScopes,
					),
				},
				counters: noCounters,
			};
		case HOSTNAME_HTTP_METRICS_QUERY_NAME:
			return {
				state: {
					...envelope,
					format: "hostname-http-packed-by-zone-v1",
					queryName: HOSTNAME_HTTP_METRICS_QUERY_NAME,
					zones: buildPackedHostnameHttpZones(
						input.previous?.queryName === HOSTNAME_HTTP_METRICS_QUERY_NAME
							? input.previous
							: undefined,
						input.metrics,
						input.failedScopes,
					),
				},
				counters: noCounters,
			};
		case LOAD_BALANCER_METRICS_QUERY_NAME:
			return {
				state: {
					...envelope,
					format: "load-balancer-packed-by-zone-v1",
					queryName: LOAD_BALANCER_METRICS_QUERY_NAME,
					zones: accumulatePackedLoadBalancerRows(
						input.previous?.queryName === LOAD_BALANCER_METRICS_QUERY_NAME
							? input.previous
							: undefined,
						input.metrics,
						input.ingestId,
						input.failedScopes,
					),
				},
				counters: noCounters,
			};
		case LB_WEIGHT_METRICS_QUERY_NAME:
			return { state: packLbWeights(input), counters: noCounters };
		case LOGPUSH_ZONE_METRICS_QUERY_NAME:
			return packLogpushZone(input);
		case ORIGIN_STATUS_METRICS_QUERY_NAME:
			return {
				state: {
					...envelope,
					format: "origin-status-packed-by-zone-v1",
					queryName: ORIGIN_STATUS_METRICS_QUERY_NAME,
					zones: accumulatePackedOriginStatusRows(
						input.previous?.queryName === ORIGIN_STATUS_METRICS_QUERY_NAME
							? input.previous
							: undefined,
						input.metrics,
						input.ingestId,
						input.failedScopes,
					),
				},
				counters: noCounters,
			};
		case REQUEST_METHOD_METRICS_QUERY_NAME:
			return packRequestMethods(input);
		case SSL_CERTIFICATES_QUERY_NAME:
			return { state: packSslCertificates(input), counters: noCounters };
	}
}

export function accumulatePackedMetricState(
	input: AccumulatePackedMetricStateInput,
): PackedMetricState {
	return accumulatePackedMetricStateWithCounters(input).state;
}
