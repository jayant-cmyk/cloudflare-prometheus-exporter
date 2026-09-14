import { serializePackedColoMetrics } from "./packed-colo-prometheus";
import {
	COLO_METRICS_QUERY_NAME,
	type PackedColoMetricState,
} from "./packed-colo-state";
import type { PackedMetricState } from "./packed-metric-state";
import type { SerializeOptions } from "./prometheus";

/** Dispatches compact snapshots to their query-specific serializers. */
export function* serializePackedMetrics(
	states: readonly PackedMetricState[],
	options: SerializeOptions,
): Generator<string> {
	const coloStates = states.filter(
		(state): state is PackedColoMetricState =>
			state.queryName === COLO_METRICS_QUERY_NAME,
	);
	yield* serializePackedColoMetrics(coloStates, options);
}
