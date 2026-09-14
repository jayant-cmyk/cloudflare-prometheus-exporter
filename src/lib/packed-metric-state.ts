import type { MetricDefinition } from "./metrics";
import {
	accumulatePackedColoRows,
	COLO_METRICS_QUERY_NAME,
	type PackedColoMetricState,
	PackedColoMetricStateSchema,
} from "./packed-colo-state";

/**
 * Shared storage key for compact metric snapshots. The value intentionally keeps
 * the original colo key so existing Durable Objects load their accumulated state.
 */
export const PACKED_METRIC_STATE_KEY = "packed-colo-metrics";

/** Query names currently backed by compact metric snapshots. */
export const PACKED_METRIC_QUERIES = [COLO_METRICS_QUERY_NAME] as const;
export type PackedMetricQuery = (typeof PACKED_METRIC_QUERIES)[number];

/**
 * Union schema for compact query snapshots. Add each new query-specific codec
 * here while the exporter and coordinators continue using this generic facade.
 */
export const PackedMetricStateSchema = PackedColoMetricStateSchema;
export type PackedMetricState = PackedColoMetricState;

export function isPackedMetricQuery(query: string): query is PackedMetricQuery {
	return (PACKED_METRIC_QUERIES as readonly string[]).includes(query);
}

/** Resolves query-specific rollout flags behind one orchestration interface. */
export function packedMetricStorageEnabled(
	query: PackedMetricQuery,
	config: { coloMetricsPackedStorage: boolean },
): boolean {
	switch (query) {
		case COLO_METRICS_QUERY_NAME:
			return config.coloMetricsPackedStorage;
	}
}

/** Returns the presentation scopes represented by a compact snapshot. */
export function packedMetricScopes(state: PackedMetricState): string[] {
	switch (state.queryName) {
		case COLO_METRICS_QUERY_NAME:
			return state.zones
				.filter((zone) => zone.colo.length > 0)
				.map((zone) => zone.zone);
	}
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

/** Dispatches accumulation to the query-specific compact state codec. */
export function accumulatePackedMetricState(
	input: AccumulatePackedMetricStateInput,
): PackedMetricState {
	switch (input.queryName) {
		case COLO_METRICS_QUERY_NAME:
			return {
				format: "colo-packed-by-zone-v2",
				accountId: input.accountId,
				accountName: input.accountName,
				queryName: COLO_METRICS_QUERY_NAME,
				lastFetch: Date.now(),
				lastIngest: input.ingestId,
				zones: accumulatePackedColoRows(
					input.previous,
					input.metrics,
					input.ingestId,
					input.failedScopes,
				),
			};
	}
}
