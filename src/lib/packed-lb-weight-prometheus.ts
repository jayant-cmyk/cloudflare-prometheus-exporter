import { serializeColumnarMetrics } from "./packed-columnar-prometheus";
import type { ColumnarFamily } from "./packed-columnar-state";
import {
	LB_WEIGHT_KEY_LABELS,
	LB_WEIGHT_METRIC_HELP,
	LB_WEIGHT_METRIC_NAME,
	type PackedLbWeightMetricState,
	packedLbWeightSamples,
} from "./packed-lb-weight-state";
import type { SerializeOptions } from "./prometheus";

const LB_WEIGHT_FAMILIES: readonly ColumnarFamily[] = [
	{
		name: LB_WEIGHT_METRIC_NAME,
		help: LB_WEIGHT_METRIC_HELP,
		type: "gauge",
		valueIndex: 0,
	},
];

export function* serializePackedLbWeightMetrics(
	states: readonly PackedLbWeightMetricState[],
	options: SerializeOptions,
): Generator<string> {
	yield* serializeColumnarMetrics(
		packedLbWeightSamples(states),
		LB_WEIGHT_FAMILIES,
		LB_WEIGHT_KEY_LABELS,
		options,
	);
}
