import {
	COLO_KEY_LABELS,
	PACKED_COLO_METRIC_FAMILIES,
	type PackedColoMetricState,
	packedColoSamples,
} from "./packed-colo-state";
import { serializeColumnarMetrics } from "./packed-columnar-prometheus";
import type { SerializeOptions } from "./prometheus";

/** Lazily serializes packed colo metrics in bounded chunks so streaming respects backpressure. */
export function* serializePackedColoMetrics(
	states: readonly PackedColoMetricState[],
	options: SerializeOptions,
): Generator<string> {
	yield* serializeColumnarMetrics(
		packedColoSamples(states),
		PACKED_COLO_METRIC_FAMILIES,
		COLO_KEY_LABELS,
		options,
	);
}
