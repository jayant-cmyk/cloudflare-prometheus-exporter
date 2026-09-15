import { serializeColumnarMetrics } from "./packed-columnar-prometheus";
import type { ColumnarFamily } from "./packed-columnar-state";
import {
	LOGPUSH_ZONE_KEY_LABELS,
	LOGPUSH_ZONE_METRIC_HELP,
	LOGPUSH_ZONE_METRIC_NAME,
	type PackedLogpushZoneMetricState,
	packedLogpushZoneSamples,
} from "./packed-logpush-zone-state";
import type { SerializeOptions } from "./prometheus";

const LOGPUSH_ZONE_FAMILIES: readonly ColumnarFamily[] = [
	{
		name: LOGPUSH_ZONE_METRIC_NAME,
		help: LOGPUSH_ZONE_METRIC_HELP,
		valueIndex: 0,
	},
];

export function* serializePackedLogpushZoneMetrics(
	states: readonly PackedLogpushZoneMetricState[],
	options: SerializeOptions,
): Generator<string> {
	yield* serializeColumnarMetrics(
		packedLogpushZoneSamples(states),
		LOGPUSH_ZONE_FAMILIES,
		LOGPUSH_ZONE_KEY_LABELS,
		options,
	);
}
