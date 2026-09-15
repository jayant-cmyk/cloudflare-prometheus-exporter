import { describe, expect, it } from "vitest";
import {
	type PackedHostnameHttpMetricState,
	serializePackedHostnameHttpMetrics,
} from "./packed-hostname-http";

describe("serializePackedHostnameHttpMetrics", () => {
	it("streams GraphQL latency values converted from milliseconds", () => {
		const state: PackedHostnameHttpMetricState = {
			format: "hostname-http-packed-by-zone-v1",
			accountId: "account-id",
			accountName: "Account",
			queryName: "hostname-http-metrics",
			lastFetch: 1,
			lastIngest: 1,
			zones: [
				{
					zone: "example.com",
					requestRows: [{ host: "www.example.com", count: 12 }],
					statusRows: [],
					cacheRows: [],
					latencyRows: [
						{
							host: "www.example.com",
							edgeTtfbMs: 100,
							edgeTtfbP50Ms: 80,
							edgeTtfbP95Ms: 180,
							originDurationMs: 200,
							originDurationP50Ms: 150,
							originDurationP95Ms: 350,
						},
					],
				},
			],
		};
		const output = [...serializePackedHostnameHttpMetrics([state], {})].join(
			"",
		);

		expect(output).toContain(
			'cloudflare_zone_hostname_edge_ttfb_p50_seconds{zone="example.com",host="www.example.com"} 0.08',
		);
		expect(output).toContain(
			'cloudflare_zone_hostname_origin_response_duration_p95_seconds{zone="example.com",host="www.example.com"} 0.35',
		);
	});
});
