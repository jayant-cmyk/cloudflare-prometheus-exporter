import { serializeColumnarMetrics } from "./packed-columnar-prometheus";
import {
	PACKED_REQUEST_METHOD_METRIC_FAMILIES,
	type PackedRequestMethodMetricState,
	packedRequestMethodSamples,
	REQUEST_METHOD_KEY_LABELS,
} from "./packed-request-method-state";
import type { SerializeOptions } from "./prometheus";

/** Lazily serializes packed request method metrics in bounded chunks. */
export function* serializePackedRequestMethodMetrics(
	states: readonly PackedRequestMethodMetricState[],
	options: SerializeOptions,
): Generator<string> {
	yield* serializeColumnarMetrics(
		packedRequestMethodSamples(states),
		PACKED_REQUEST_METHOD_METRIC_FAMILIES,
		REQUEST_METHOD_KEY_LABELS,
		options,
	);
}
