import { serializeColumnarMetrics } from "./packed-columnar-prometheus";
import {
	ORIGIN_STATUS_KEY_LABELS,
	PACKED_ORIGIN_STATUS_METRIC_FAMILIES,
	type PackedOriginStatusMetricState,
	packedOriginStatusSamples,
} from "./packed-origin-status-state";
import type { SerializeOptions } from "./prometheus";

/** Lazily serializes packed origin status metrics in bounded chunks. */
export function* serializePackedOriginStatusMetrics(
	states: readonly PackedOriginStatusMetricState[],
	options: SerializeOptions,
): Generator<string> {
	yield* serializeColumnarMetrics(
		packedOriginStatusSamples(states),
		PACKED_ORIGIN_STATUS_METRIC_FAMILIES,
		ORIGIN_STATUS_KEY_LABELS,
		options,
	);
}
