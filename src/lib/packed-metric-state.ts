import {
	accumulateColumnarMetricState,
	COLUMNAR_METRIC_QUERIES,
	type ColumnarMetricQuery,
	type ColumnarMetricSource,
	isColumnarMetricQuery,
	PackedColumnarMetricStateSchema,
} from "./packed-columnar-metric";

export type PackedMetricQuery = ColumnarMetricQuery;

export const PACKED_METRIC_QUERIES = COLUMNAR_METRIC_QUERIES;

export const PACKED_METRIC_STATE_KEY = "packed-colo-metrics";

export const PackedMetricStateSchema = PackedColumnarMetricStateSchema;
export type PackedMetricState = ReturnType<
	typeof accumulateColumnarMetricState
>;

export function isPackedMetricQuery(query: string): query is PackedMetricQuery {
	return isColumnarMetricQuery(query);
}

type AccumulateInput = {
	previous: PackedMetricState | undefined;
	metrics: readonly ColumnarMetricSource[];
	ingestId: number;
	failedScopes: ReadonlySet<string>;
};

export function accumulatePackedMetricState(
	input: AccumulateInput,
): PackedMetricState {
	return accumulateColumnarMetricState({
		previous: input.previous,
		metrics: input.metrics,
		ingestId: input.ingestId,
		failedScopes: input.failedScopes,
	});
}
