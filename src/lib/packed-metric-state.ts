import { z } from "zod";
import type { MetricDefinition } from "./metrics";
import {
	CACHE_MISS_METRICS_QUERY_NAME,
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
	LB_WEIGHT_METRICS_QUERY_NAME,
	PackedLbWeightMetricStateSchema,
} from "./packed-lb-weight-state";
import {
	LOGPUSH_ZONE_METRICS_QUERY_NAME,
	PackedLogpushZoneMetricStateSchema,
} from "./packed-logpush-zone-state";
import {
	accumulatePackedOriginStatusRows,
	ORIGIN_STATUS_METRICS_QUERY_NAME,
	PackedOriginStatusMetricStateSchema,
} from "./packed-origin-status-state";
import {
	PackedRequestMethodMetricStateSchema,
	REQUEST_METHOD_METRICS_QUERY_NAME,
} from "./packed-request-method-state";
import {
	PackedSSLCertificateMetricStateSchema,
	SSL_CERTIFICATES_QUERY_NAME,
} from "./packed-ssl-certificates-state";

/** Query names currently backed by compact metric snapshots. */
export const PACKED_METRIC_QUERIES = [
	CACHE_MISS_METRICS_QUERY_NAME,
	COLO_ERROR_METRICS_QUERY_NAME,
	COLO_METRICS_QUERY_NAME,
	LB_WEIGHT_METRICS_QUERY_NAME,
	LOGPUSH_ZONE_METRICS_QUERY_NAME,
	ORIGIN_STATUS_METRICS_QUERY_NAME,
	REQUEST_METHOD_METRICS_QUERY_NAME,
	SSL_CERTIFICATES_QUERY_NAME,
] as const;
export type PackedMetricQuery = (typeof PACKED_METRIC_QUERIES)[number];

const METRIC_DEFINITION_PACKED_QUERIES = [
	COLO_ERROR_METRICS_QUERY_NAME,
	COLO_METRICS_QUERY_NAME,
	ORIGIN_STATUS_METRICS_QUERY_NAME,
] as const;
export type MetricDefinitionPackedQuery =
	(typeof METRIC_DEFINITION_PACKED_QUERIES)[number];

/**
 * Storage keys for compact snapshots, one per query. Colo intentionally keeps
 * its original key so already-deployed Durable Objects load the state they have
 * already accumulated.
 */
const PACKED_METRIC_STATE_KEYS: Record<PackedMetricQuery, string> = {
	[CACHE_MISS_METRICS_QUERY_NAME]: "packed-cache-miss-metrics",
	[COLO_ERROR_METRICS_QUERY_NAME]: "packed-colo-error-metrics",
	[COLO_METRICS_QUERY_NAME]: "packed-colo-metrics",
	[LB_WEIGHT_METRICS_QUERY_NAME]: "packed-lb-weight-metrics",
	[LOGPUSH_ZONE_METRICS_QUERY_NAME]: "packed-logpush-zone-metrics",
	[ORIGIN_STATUS_METRICS_QUERY_NAME]: "packed-origin-status-metrics",
	[REQUEST_METHOD_METRICS_QUERY_NAME]: "packed-request-method-metrics",
	[SSL_CERTIFICATES_QUERY_NAME]: "packed-ssl-certificates",
};

/**
 * Union schema for compact query snapshots. Add each new query-specific codec
 * here while the exporter and coordinators continue using this generic facade.
 */
export const PackedMetricStateSchema = z.discriminatedUnion("queryName", [
	PackedCacheMissMetricStateSchema,
	PackedColoErrorMetricStateSchema,
	PackedColoMetricStateSchema,
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

/** Resolves the storage key holding a query's compact snapshot. */
export function packedMetricStateKey(query: PackedMetricQuery): string {
	return PACKED_METRIC_STATE_KEYS[query];
}

/**
 * Resolves the rollout flag behind one orchestration interface. All packed
 * queries share a single flag today; the query stays a parameter so a per-query
 * rollout can be introduced without touching the Durable Objects.
 */
export function packedMetricStorageEnabled(
	_query: PackedMetricQuery,
	config: { packedMetricStorage: boolean },
): boolean {
	return config.packedMetricStorage;
}

/** Returns the presentation scopes represented by a compact snapshot. */
export function packedMetricScopes(state: PackedMetricState): string[] {
	switch (state.queryName) {
		case CACHE_MISS_METRICS_QUERY_NAME:
			return state.zones
				.filter((zone) => zone.rows.some((row) => row.count > 0))
				.map((zone) => zone.zone);
		case LB_WEIGHT_METRICS_QUERY_NAME:
		case LOGPUSH_ZONE_METRICS_QUERY_NAME:
		case REQUEST_METHOD_METRICS_QUERY_NAME:
		case SSL_CERTIFICATES_QUERY_NAME:
			return state.zones
				.filter((zone) => zone.rows.length > 0)
				.map((zone) => zone.zone);
		default:
			return state.zones
				.filter((zone) => zone.misses.length > 0)
				.map((zone) => zone.zone);
	}
}

export type AccumulatePackedMetricStateInput = {
	queryName: MetricDefinitionPackedQuery;
	accountId: string;
	accountName: string;
	previous: PackedMetricState | undefined;
	metrics: readonly MetricDefinition[];
	ingestId: number;
	failedScopes: ReadonlySet<string>;
};

/**
 * Narrows a stored snapshot to the codec that produced it, so a snapshot left
 * over from another query is treated as absent instead of mis-parsed.
 */
function previousFor<Q extends MetricDefinitionPackedQuery>(
	previous: PackedMetricState | undefined,
	queryName: Q,
): Extract<PackedMetricState, { queryName: Q }> | undefined {
	return previous?.queryName === queryName
		? (previous as Extract<PackedMetricState, { queryName: Q }>)
		: undefined;
}

/** Dispatches accumulation to the query-specific compact state codec. */
export function accumulatePackedMetricState(
	input: AccumulatePackedMetricStateInput,
): PackedMetricState {
	const envelope = {
		accountId: input.accountId,
		accountName: input.accountName,
		lastFetch: Date.now(),
		lastIngest: input.ingestId,
	};

	switch (input.queryName) {
		case COLO_ERROR_METRICS_QUERY_NAME:
			return {
				...envelope,
				format: "colo-error-packed-by-zone-v1",
				queryName: COLO_ERROR_METRICS_QUERY_NAME,
				zones: accumulatePackedColoErrorRows(
					previousFor(input.previous, COLO_ERROR_METRICS_QUERY_NAME),
					input.metrics,
					input.ingestId,
					input.failedScopes,
				),
			};
		case COLO_METRICS_QUERY_NAME:
			return {
				...envelope,
				format: "colo-packed-by-zone-v2",
				queryName: COLO_METRICS_QUERY_NAME,
				zones: accumulatePackedColoRows(
					previousFor(input.previous, COLO_METRICS_QUERY_NAME),
					input.metrics,
					input.ingestId,
					input.failedScopes,
				),
			};
		case ORIGIN_STATUS_METRICS_QUERY_NAME:
			return {
				...envelope,
				format: "origin-status-packed-by-zone-v1",
				queryName: ORIGIN_STATUS_METRICS_QUERY_NAME,
				zones: accumulatePackedOriginStatusRows(
					previousFor(input.previous, ORIGIN_STATUS_METRICS_QUERY_NAME),
					input.metrics,
					input.ingestId,
					input.failedScopes,
				),
			};
		default: {
			const _exhaustive: never = input.queryName;
			throw new Error(
				`Unsupported packed metric definition query: ${_exhaustive}`,
			);
		}
	}
}

export function isMetricDefinitionPackedQuery(
	query: PackedMetricQuery,
): query is MetricDefinitionPackedQuery {
	return (METRIC_DEFINITION_PACKED_QUERIES as readonly string[]).includes(
		query,
	);
}
