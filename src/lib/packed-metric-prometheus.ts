import { serializeColumnarMetricStates } from "./packed-columnar-metric";
import type { PackedMetricState } from "./packed-metric-state";
import type { SerializeOptions } from "./prometheus";

export function* serializePackedMetrics(
	states: readonly PackedMetricState[],
	options: SerializeOptions,
): Generator<string> {
	yield* serializeColumnarMetricStates(states, options);
}
