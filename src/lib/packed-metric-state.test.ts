import { describe, expect, it, vi } from "vitest";
import type { MetricDefinition } from "./metrics";
import {
	accumulatePackedMetricState,
	isPackedMetricQuery,
	PACKED_METRIC_QUERIES,
} from "./packed-metric-state";

const labels = {
	zone: "example.com",
	colo: "SJC",
	host: "www.example.com",
};

const coloMetrics: MetricDefinition[] = [
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

const originStatusMetrics: MetricDefinition[] = [
	{
		name: "cloudflare_zone_requests_origin_status_country_host_total",
		help: "Requests by origin status, country, and host",
		type: "counter",
		values: [
			{
				labels: {
					zone: "example.com",
					origin_status: "200",
					country: "US",
					host: "www.example.com",
				},
				value: 7,
			},
		],
	},
];

describe("packed metric state facade", () => {
	it("registers every packed query", () => {
		for (const query of PACKED_METRIC_QUERIES) {
			expect(isPackedMetricQuery(query)).toBe(true);
		}
		expect(isPackedMetricQuery("account-metrics")).toBe(false);
	});

	it("retains the dedicated colo codec", () => {
		vi.spyOn(Date, "now").mockReturnValue(123);
		const state = accumulatePackedMetricState({
			queryName: "colo-metrics",
			accountId: "account-id",
			accountName: "Account",
			previous: undefined,
			metrics: coloMetrics,
			ingestId: 10,
			failedScopes: new Set(),
		});

		expect(state).toMatchObject({
			format: "colo-packed-by-zone-v2",
			lastFetch: 123,
			lastIngest: 10,
			zones: [
				{
					zone: "example.com",
					colo: ["SJC"],
					host: ["www.example.com"],
					visits: [2],
					edgeResponseBytes: [3],
					requests: [4],
				},
			],
		});
	});

	it("dispatches other queries to the generic columnar codec", () => {
		const state = accumulatePackedMetricState({
			queryName: "origin-status-metrics",
			accountId: "account-id",
			accountName: "Account",
			previous: undefined,
			metrics: originStatusMetrics,
			ingestId: 20,
			failedScopes: new Set(),
		});

		expect(state).toMatchObject({
			format: "metric-columnar-v1",
			zones: [
				{
					zone: "example.com",
					families: [
						{
							family: 0,
							labels: {
								origin_status: ["200"],
								country: ["US"],
								host: ["www.example.com"],
							},
							values: [7],
						},
					],
				},
			],
		});
	});

	it("does not adopt a snapshot from another codec", () => {
		const colo = accumulatePackedMetricState({
			queryName: "colo-metrics",
			accountId: "account-id",
			accountName: "Account",
			previous: undefined,
			metrics: coloMetrics,
			ingestId: 10,
			failedScopes: new Set(),
		});
		const state = accumulatePackedMetricState({
			queryName: "origin-status-metrics",
			accountId: "account-id",
			accountName: "Account",
			previous: colo,
			metrics: originStatusMetrics,
			ingestId: 20,
			failedScopes: new Set(),
		});

		expect(state.format).toBe("metric-columnar-v1");
		expect(state.zones).toHaveLength(1);
	});
});
