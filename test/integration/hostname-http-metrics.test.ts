/// <reference types="@cloudflare/vitest-plugin/types" />

import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CLOUDFLARE_GQL_URL } from "../../src/cloudflare/client";

const network = setupNetwork();

beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());

describe("hostname-http-metrics Durable Object", () => {
	it("preserves aliases, lowercase hosts, quantiles, and the one-minute window", async () => {
		const accountId = "hostname-account";
		const zone = {
			id: "hostname-zone",
			name: "example.com",
			status: "active",
			plan: { id: "paid", name: "Paid" },
			account: { id: accountId, name: accountId },
		};
		let queryWindowMs = 0;
		network.use(
			http.post(CLOUDFLARE_GQL_URL, async ({ request }) => {
				const body = z
					.object({
						variables: z.object({ mintime: z.string(), maxtime: z.string() }),
					})
					.parse(await request.json());
				queryWindowMs =
					new Date(body.variables.maxtime).getTime() -
					new Date(body.variables.mintime).getTime();
				const host = "EXAMPLE.COM";
				return HttpResponse.json({
					data: {
						viewer: {
							zones: [
								{
									zoneTag: zone.id,
									hostRequests: [
										{ dimensions: { clientRequestHTTPHost: host }, count: 12 },
									],
									hostStatus: [
										{
											dimensions: {
												clientRequestHTTPHost: host,
												edgeResponseStatus: 200,
											},
											count: 12,
										},
									],
									hostCache: [
										{
											dimensions: {
												clientRequestHTTPHost: host,
												cacheStatus: "hit",
											},
											count: 10,
										},
									],
									hostLatency: [
										{
											dimensions: { clientRequestHTTPHost: host },
											avg: {
												edgeTimeToFirstByteMs: 100,
												originResponseDurationMs: 200,
											},
											quantiles: {
												edgeTimeToFirstByteMsP50: 80,
												edgeTimeToFirstByteMsP95: 180,
												originResponseDurationMsP50: 150,
												originResponseDurationMsP95: 350,
											},
										},
									],
								},
							],
						},
					},
				});
			}),
		);

		const id = `account:${accountId}:hostname-http-metrics`;
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
		if (snapshot?.queryName !== "hostname-http-metrics") {
			throw new Error("expected packed hostname metrics");
		}
		expect(queryWindowMs).toBe(60_000);
		expect(snapshot.zones[0]?.requestRows[0]).toEqual({
			host: "example.com",
			count: 12,
		});
		expect(snapshot.zones[0]?.latencyRows[0]).toMatchObject({
			host: "example.com",
			edgeTtfbMs: 100,
			edgeTtfbP50Ms: 80,
			edgeTtfbP95Ms: 180,
			originDurationP50Ms: 150,
			originDurationP95Ms: 350,
		});
	});
});
