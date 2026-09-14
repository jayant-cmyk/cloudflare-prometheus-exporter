import {
	CACHE_MISS_KEY_LABELS,
	PACKED_CACHE_MISS_METRIC_FAMILIES,
	type PackedCacheMissMetricState,
	packedCacheMissSamples,
} from "./packed-cache-miss-state";
import { serializeColumnarMetrics } from "./packed-columnar-prometheus";
import type { SerializeOptions } from "./prometheus";

/** Lazily serializes packed cache miss metrics in bounded chunks. */
export function* serializePackedCacheMissMetrics(
	states: readonly PackedCacheMissMetricState[],
	options: SerializeOptions,
): Generator<string> {
	yield* serializeColumnarMetrics(
		packedCacheMissSamples(states),
		PACKED_CACHE_MISS_METRIC_FAMILIES,
		CACHE_MISS_KEY_LABELS,
		options,
	);
}
