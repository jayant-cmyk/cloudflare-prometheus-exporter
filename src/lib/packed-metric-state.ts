import { z } from "zod";
import type { MetricDefinition } from "./metrics";
import {
	accumulatePackedColoRows,
	COLO_METRICS_QUERY_NAME,
	PackedColoMetricStateSchema,
} from "./packed-colo-state";
import {
	accumulatePackedOriginStatusRows,
	ORIGIN_STATUS_METRICS_QUERY_NAME,
	PackedOriginStatusMetricStateSchema,
} from "./packed-origin-status-state";

/** Query names currently backed by compact metric snapshots. */
export const PACKED_METRIC_QUERIES = [
	COLO_METRICS_QUERY_NAME,
	ORIGIN_STATUS_METRICS_QUERY_NAME,
] as const;
export type PackedMetricQuery = (typeof PACKED_METRIC_QUERIES)[number];

/**
 * Storage keys for compact snapshots, one per query. Colo intentionally keeps
 * its original key so already-deployed Durable Objects load the state they have
 * already accumulated.
 */
const PACKED_METRIC_STATE_KEYS: Record<PackedMetricQuery, string> = {
	[COLO_METRICS_QUERY_NAME]: "packed-colo-metrics",
	[ORIGIN_STATUS_METRICS_QUERY_NAME]: "packed-origin-status-metrics",
};

/**
 * Union schema for compact query snapshots. Add each new query-specific codec
 * here while the exporter and coordinators continue using this generic facade.
 */
export const PackedMetricStateSchema = z.discriminatedUnion("queryName", [
	PackedColoMetricStateSchema,
	PackedOriginStatusMetricStateSchema,
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

/**
 * Returns the presentation scopes represented by a compact snapshot.
 * Every codec ages rows through the `misses` column, so its length is the
 * row count regardless of which query produced the snapshot.
 */
export function packedMetricScopes(state: PackedMetricState): string[] {
	return state.zones
		.filter((zone) => zone.misses.length > 0)
		.map((zone) => zone.zone);
}

export type AccumulatePackedMetricStateInput = {
	queryName: PackedMetricQuery;
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
function previousFor<Q extends PackedMetricQuery>(
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
	}
}
