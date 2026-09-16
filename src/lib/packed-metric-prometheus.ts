import { serializePackedColoMetrics } from "./packed-colo-prometheus";
import type { PackedColoMetricState } from "./packed-colo-state";
import {
	type PackedColumnarMetricState,
	serializeColumnarMetricStates,
} from "./packed-columnar-metric";
import type { PackedMetricState } from "./packed-metric-state";
import type { SerializeOptions } from "./prometheus";

export function* serializePackedMetrics(
	states: readonly PackedMetricState[],
	options: SerializeOptions,
): Generator<string> {
	const coloStates = states.filter(
		(state): state is PackedColoMetricState =>
			state.format === "colo-packed-by-zone-v2",
	);
	yield* serializePackedColoMetrics(coloStates, options);
	const columnarStates = states.filter(
		(state): state is PackedColumnarMetricState =>
			state.format === "metric-columnar-v1",
	);
	yield* serializeColumnarMetricStates(columnarStates, options);
}
