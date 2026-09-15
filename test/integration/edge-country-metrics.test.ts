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

describe("edge-country-metrics Durable Object", () => {
	it("stores detailed counters and per-zone error totals", async () => {
		const accountId = "edge-country-account";
		const zone = {
			id: "edge-country-zone",
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
									httpRequestsEdgeCountryHost: [
										{
											dimensions: {
												edgeResponseStatus: 200,
												clientCountryName: "US",
												clientRequestHTTPHost: "www.example.com",
											},
											count: 8,
										},
										{
											dimensions: {
												edgeResponseStatus: 500,
												clientCountryName: "US",
												clientRequestHTTPHost: "www.example.com",
											},
											count: 2,
										},
									],
								},
							],
						},
					},
				}),
			),
		);

		const id = `account:${accountId}:edge-country-metrics`;
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
		if (snapshot?.queryName !== "edge-country-metrics") {
			throw new Error("expected packed edge country metrics");
		}
		expect(snapshot.zones[0]).toMatchObject({
			zone: "example.com",
			edgeStatus: ["200", "500"],
			count: [8, 2],
			total: 10,
			errors: 2,
		});
	});
});
