/// <reference types="@cloudflare/vitest-plugin/types" />

import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CLOUDFLARE_GQL_URL } from "../../src/cloudflare/client";

const network = setupNetwork();

beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());

describe("health-check-metrics Durable Object", () => {
	it("stores independent event and timing aliases", async () => {
		const accountId = "health-check-account";
		const zone = {
			id: "health-check-zone",
			name: "example.com",
			status: "active",
			plan: { id: "paid", name: "Paid" },
			account: { id: accountId, name: accountId },
		};
		network.use(
			http.post(CLOUDFLARE_GQL_URL, () =>
				HttpResponse.json({
					data: {
						viewer: {
							zones: [
								{
									zoneTag: zone.id,
									healthEvents: [
										{
											dimensions: {
												healthStatus: "healthy",
												originIP: "192.0.2.1",
												region: "WEUR",
												fqdn: "origin.example.com",
												failureReason: "",
											},
											count: 6,
										},
										{
											dimensions: {
												healthStatus: "unhealthy",
												originIP: "192.0.2.1",
												region: "WEUR",
												fqdn: "origin.example.com",
												failureReason: "timeout",
											},
											count: 2,
										},
									],
									healthTimings: [
										{
											dimensions: {
												originIP: "192.0.2.1",
												fqdn: "origin.example.com",
											},
											avg: {
												rttMs: 10,
												timeToFirstByteMs: 20,
												tcpConnMs: 30,
												tlsHandshakeMs: 40,
											},
										},
									],
								},
							],
						},
					},
				}),
			),
		);

		const id = `account:${accountId}:health-check-metrics`;
		const stub = env.MetricExporter.getByName(id);
		await stub.initialize(id);
		await stub.updateZoneContext(
			accountId,
			accountId,
			[zone],
			{},
			{
				mintime: "2026-01-01T00:00:00.000Z",
				maxtime: "2026-01-01T00:01:00.000Z",
			},
		);
		await evictDurableObject(stub);

		const snapshot = await stub.exportPackedMetrics();
		if (snapshot?.queryName !== "health-check-metrics") {
			throw new Error("expected packed health check metrics");
		}
		expect(snapshot.zones[0]).toMatchObject({
			zone: "example.com",
			totalEvents: 8,
			groupCount: 2,
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
		});
		expect(snapshot.zones[0]?.eventRows.map((row) => row.count)).toEqual([
			6, 2,
		]);
	});
});
