import {
	COLO_ERROR_KEY_LABELS,
	PACKED_COLO_ERROR_METRIC_FAMILIES,
	type PackedColoErrorMetricState,
	packedColoErrorSamples,
} from "./packed-colo-error-state";
import { serializeColumnarMetrics } from "./packed-columnar-prometheus";
import type { SerializeOptions } from "./prometheus";

export function* serializePackedColoErrorMetrics(
	states: readonly PackedColoErrorMetricState[],
	options: SerializeOptions,
): Generator<string> {
	yield* serializeColumnarMetrics(
		packedColoErrorSamples(states),
		PACKED_COLO_ERROR_METRIC_FAMILIES,
		COLO_ERROR_KEY_LABELS,
		options,
	);
}
