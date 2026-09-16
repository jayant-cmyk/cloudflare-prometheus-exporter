import { z } from "zod";
import type { MetricDefinition } from "./metrics";
import {
	accumulatePackedColoRows,
	COLO_METRICS_QUERY_NAME,
	PackedColoMetricStateSchema,
} from "./packed-colo-state";
import {
	accumulateColumnarMetricState,
	COLUMNAR_METRIC_QUERIES,
	type ColumnarMetricQuery,
	isColumnarMetricQuery,
	PackedColumnarMetricStateSchema,
} from "./packed-columnar-metric";

export type PackedMetricQuery =
	| typeof COLO_METRICS_QUERY_NAME
	| ColumnarMetricQuery;

export const PACKED_METRIC_QUERIES = [
	COLO_METRICS_QUERY_NAME,
	...COLUMNAR_METRIC_QUERIES,
] as const satisfies readonly PackedMetricQuery[];

export const PACKED_METRIC_STATE_KEY = "packed-colo-metrics";

export const PackedMetricStateSchema = z.union([
	PackedColoMetricStateSchema,
	PackedColumnarMetricStateSchema,
]);
export type PackedMetricState = z.infer<typeof PackedMetricStateSchema>;

export function isPackedMetricQuery(query: string): query is PackedMetricQuery {
	return query === COLO_METRICS_QUERY_NAME || isColumnarMetricQuery(query);
}

type AccumulateInput = {
	queryName: PackedMetricQuery;
	accountId: string;
	accountName: string;
	previous: PackedMetricState | undefined;
	metrics: MetricDefinition[];
	ingestId: number;
	failedScopes: ReadonlySet<string>;
};

export function accumulatePackedMetricState(
	input: AccumulateInput,
): PackedMetricState {
	if (input.queryName === COLO_METRICS_QUERY_NAME) {
		return {
			format: "colo-packed-by-zone-v2",
			accountId: input.accountId,
			accountName: input.accountName,
			queryName: COLO_METRICS_QUERY_NAME,
			lastFetch: Date.now(),
			lastIngest: input.ingestId,
			zones: accumulatePackedColoRows(
				input.previous?.format === "colo-packed-by-zone-v2"
					? input.previous
					: undefined,
				input.metrics,
				input.ingestId,
				input.failedScopes,
			),
		};
	}

	return accumulateColumnarMetricState({
		previous:
			input.previous?.format === "metric-columnar-v1"
				? input.previous
				: undefined,
		metrics: input.metrics,
		ingestId: input.ingestId,
		failedScopes: input.failedScopes,
	});
}
