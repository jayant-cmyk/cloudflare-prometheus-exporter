import { describe, expect, it } from "vitest";
import {
	type PackedEdgeCountryMetricState,
	serializePackedEdgeCountryMetrics,
} from "./packed-edge-country";

describe("serializePackedEdgeCountryMetrics", () => {
	it("streams detailed counters and the per-zone error rate", () => {
		const state: PackedEdgeCountryMetricState = {
			format: "edge-country-packed-by-zone-v1",
			accountId: "account-id",
			accountName: "Account",
			queryName: "edge-country-metrics",
			lastFetch: 1,
			lastIngest: 1,
			zones: [
				{
					zone: "example.com",
					edgeStatus: ["500"],
					country: ["US"],
					host: ["www.example.com"],
					count: [2],
					misses: [5],
					lastIngest: [1],
					total: 10,
					errors: 2,
				},
			],
		};
		const output = [...serializePackedEdgeCountryMetrics([state], {})].join("");

		expect(output).toContain(
			'cloudflare_zone_requests_status_country_host_total{zone="example.com",edge_status="500",country="US",host="www.example.com"} 2',
		);
		expect(output).toContain(
			'cloudflare_zone_edge_error_rate{zone="example.com"} 0.2',
		);
	});
});
