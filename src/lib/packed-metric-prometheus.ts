import { serializePackedColoMetrics } from "./packed-colo-prometheus";
import {
	COLO_METRICS_QUERY_NAME,
	type PackedColoMetricState,
} from "./packed-colo-state";
import type { PackedMetricState } from "./packed-metric-state";
import { serializePackedOriginStatusMetrics } from "./packed-origin-status-prometheus";
import {
	ORIGIN_STATUS_METRICS_QUERY_NAME,
	type PackedOriginStatusMetricState,
} from "./packed-origin-status-state";
import type { SerializeOptions } from "./prometheus";

/**
 * Dispatches compact snapshots to their query-specific serializers.
 * Families are grouped per query so a scrape never splits one metric family
 * across two HELP/TYPE blocks, which Prometheus rejects.
 */
export function* serializePackedMetrics(
	states: readonly PackedMetricState[],
	options: SerializeOptions,
): Generator<string> {
	const coloStates: PackedColoMetricState[] = [];
	const originStatusStates: PackedOriginStatusMetricState[] = [];
	for (const state of states) {
		switch (state.queryName) {
			case COLO_METRICS_QUERY_NAME:
				coloStates.push(state);
				break;
			case ORIGIN_STATUS_METRICS_QUERY_NAME:
				originStatusStates.push(state);
				break;
		}
	}

	yield* serializePackedColoMetrics(coloStates, options);
	yield* serializePackedOriginStatusMetrics(originStatusStates, options);
}
