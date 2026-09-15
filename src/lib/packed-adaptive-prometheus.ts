import {
	ADAPTIVE_4XX_METRIC_HELP,
	ADAPTIVE_4XX_METRIC_NAME,
	ADAPTIVE_5XX_METRIC_HELP,
	ADAPTIVE_5XX_METRIC_NAME,
	ADAPTIVE_DURATION_METRIC_HELP,
	ADAPTIVE_DURATION_METRIC_NAME,
	ADAPTIVE_KEY_LABELS,
	ADAPTIVE_RATE_METRIC_HELP,
	ADAPTIVE_RATE_METRIC_NAME,
	type PackedAdaptiveMetricState,
	packedAdaptiveRateSamples,
	packedAdaptiveSamples,
} from "./packed-adaptive-state";
import { serializeColumnarMetrics } from "./packed-columnar-prometheus";
import type { ColumnarFamily } from "./packed-columnar-state";
import type { SerializeOptions } from "./prometheus";

const ADAPTIVE_ROW_FAMILIES: readonly ColumnarFamily[] = [
	{
		name: ADAPTIVE_4XX_METRIC_NAME,
		help: ADAPTIVE_4XX_METRIC_HELP,
		valueIndex: 0,
	},
	{
		name: ADAPTIVE_5XX_METRIC_NAME,
		help: ADAPTIVE_5XX_METRIC_HELP,
		valueIndex: 1,
	},
	{
		name: ADAPTIVE_DURATION_METRIC_NAME,
		help: ADAPTIVE_DURATION_METRIC_HELP,
		type: "gauge",
		valueIndex: 2,
	},
];

const ADAPTIVE_RATE_FAMILIES: readonly ColumnarFamily[] = [
	{
		name: ADAPTIVE_RATE_METRIC_NAME,
		help: ADAPTIVE_RATE_METRIC_HELP,
		type: "gauge",
		valueIndex: 0,
	},
];

export function* serializePackedAdaptiveMetrics(
	states: readonly PackedAdaptiveMetricState[],
	options: SerializeOptions,
): Generator<string> {
	yield* serializeColumnarMetrics(
		packedAdaptiveSamples(states),
		ADAPTIVE_ROW_FAMILIES,
		ADAPTIVE_KEY_LABELS,
		options,
	);
	yield* serializeColumnarMetrics(
		packedAdaptiveRateSamples(states),
		ADAPTIVE_RATE_FAMILIES,
		[],
		options,
	);
}
