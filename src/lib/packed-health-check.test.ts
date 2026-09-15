import { describe, expect, it } from "vitest";
import {
	type PackedHealthCheckMetricState,
	serializePackedHealthCheckMetrics,
} from "./packed-health-check";

describe("serializePackedHealthCheckMetrics", () => {
	it("streams event averages and timing rows", () => {
		const state: PackedHealthCheckMetricState = {
			format: "health-check-packed-by-zone-v1",
			accountId: "account-id",
			accountName: "Account",
			queryName: "health-check-metrics",
			lastFetch: 1,
			lastIngest: 1,
			zones: [
				{
					zone: "example.com",
					eventRows: [
						{
							healthStatus: "healthy",
							originIp: "192.0.2.1",
							region: "WEUR",
							fqdn: "origin.example.com",
							failureReason: "",
							count: 8,
							misses: 5,
							lastIngest: 1,
						},
					],
					timingRows: [
						{
							originIp: "192.0.2.1",
							fqdn: "origin.example.com",
							rttMs: 10,
							ttfbMs: 20,
							tcpConnMs: 30,
							tlsHandshakeMs: 40,
						},
					],
					totalEvents: 8,
					groupCount: 2,
				},
			],
		};
		const output = [...serializePackedHealthCheckMetrics([state], {})].join("");

		expect(output).toContain(
			'cloudflare_zone_health_check_events_avg{zone="example.com"} 4',
		);
		expect(output).toContain(
			'cloudflare_zone_health_check_tls_handshake_seconds{zone="example.com",origin_ip="192.0.2.1",fqdn="origin.example.com"} 0.04',
		);
	});
});
