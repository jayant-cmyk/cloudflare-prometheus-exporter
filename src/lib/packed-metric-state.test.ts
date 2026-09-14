import { describe, expect, it, vi } from "vitest";
import type { MetricDefinition } from "./metrics";
import {
	accumulatePackedMetricState,
	isPackedMetricQuery,
	PACKED_METRIC_QUERIES,
	PACKED_METRIC_STATE_KEY,
	packedMetricScopes,
	packedMetricStorageEnabled,
} from "./packed-metric-state";

const labels = { zone: "example.com", colo: "SJC", host: "www.example.com" };

const metrics: MetricDefinition[] = [
	{
		name: "cloudflare_zone_colocation_visits_total",
		help: "Visits per colo",
		type: "counter",
		values: [{ labels, value: 2 }],
	},
	{
		name: "cloudflare_zone_colocation_edge_response_bytes_total",
		help: "Edge response bytes per colo",
		type: "counter",
		values: [{ labels, value: 3 }],
	},
	{
		name: "cloudflare_zone_colocation_requests_total",
		help: "Requests per colo",
		type: "counter",
		values: [{ labels, value: 4 }],
	},
];

describe("packed metric state facade", () => {
	it("keeps the shipped colo storage key while exposing generic query selection", () => {
		expect(PACKED_METRIC_STATE_KEY).toBe("packed-colo-metrics");
		expect(PACKED_METRIC_QUERIES).toEqual(["colo-metrics"]);
		expect(isPackedMetricQuery("colo-metrics")).toBe(true);
		expect(isPackedMetricQuery("origin-status-metrics")).toBe(false);
		expect(
			packedMetricStorageEnabled("colo-metrics", {
				coloMetricsPackedStorage: true,
			}),
		).toBe(true);
	});

	it("dispatches accumulation and scope discovery to the colo codec", () => {
		vi.spyOn(Date, "now").mockReturnValue(123);
		const state = accumulatePackedMetricState({
			queryName: "colo-metrics",
			accountId: "account-id",
			accountName: "Account",
			previous: undefined,
			metrics,
			ingestId: 10,
			failedScopes: new Set(),
		});

		expect(state).toMatchObject({
			format: "colo-packed-by-zone-v2",
			accountId: "account-id",
			queryName: "colo-metrics",
			lastFetch: 123,
			lastIngest: 10,
		});
		expect(state.zones[0]).toMatchObject({
			zone: "example.com",
			colo: ["SJC"],
			host: ["www.example.com"],
			visits: [2],
			edgeResponseBytes: [3],
			requests: [4],
		});
		expect(packedMetricScopes(state)).toEqual(["example.com"]);
	});
});
