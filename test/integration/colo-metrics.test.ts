/// <reference types="@cloudflare/vitest-plugin/types" />

import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CLOUDFLARE_GQL_URL } from "../../src/cloudflare/client";
import type { MetricExporter } from "../../src/durable-objects/MetricExporter";

const network = setupNetwork();
const sampleValue = 10;

beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());

describe("colo-metrics Durable Object", () => {
	it.each([
		{
			name: "100-row account",
			accountId: "account-small",
			zoneCount: 1,
			rowsPerZone: 100,
		},
		{
			name: "150000-row account",
			accountId: "account-large",
			zoneCount: 15,
			rowsPerZone: 10_000,
		},
	])("refreshes and reads $name", async ({
		accountId,
		zoneCount,
		rowsPerZone,
	}) => {
		const zones = Array.from({ length: zoneCount }, (_, index) => ({
			id: `${accountId}-zone-${index}`,
			name: `${accountId}-zone-${index}.example.com`,
			status: "active",
			plan: { id: "paid", name: "Paid" },
			account: { id: accountId, name: accountId },
		}));
		const groups = Array.from({ length: rowsPerZone }, (_, index) => ({
			dimensions: {
				coloCode: "SJC",
				clientRequestHTTPHost: `host-${index}.example.com`,
			},
			count: sampleValue,
			sum: { visits: sampleValue, edgeResponseBytes: sampleValue },
		}));
		let graphQLRequests = 0;
		network.use(
			http.post(CLOUDFLARE_GQL_URL, async ({ request }) => {
				graphQLRequests++;
				const body = z
					.object({ variables: z.object({ zoneIDs: z.array(z.string()) }) })
					.parse(await request.json());
				const requestedZones = new Set(body.variables.zoneIDs);
				return HttpResponse.json({
					data: {
						viewer: {
							zones: zones
								.filter((zone) => requestedZones.has(zone.id))
								.map((zone) => ({
									zoneTag: zone.id,
									httpRequestsAdaptiveGroups: groups,
								})),
						},
					},
				});
			}),
		);
		const stub = env.MetricExporter.getByName(
			`account:${accountId}:colo-metrics`,
		);
		await stub.initialize(`account:${accountId}:colo-metrics`);
		await stub.updateZoneContext(
			accountId,
			accountId,
			zones,
			{},
			{
				mintime: "2026-01-01T00:00:00.000Z",
				maxtime: "2026-01-01T00:01:00.000Z",
			},
		);

		const lastError = await runInDurableObject(
			stub,
			async (_instance: MetricExporter, state) => {
				const stored = await state.storage.get<{ lastError: string | null }>(
					"state",
				);
				return stored?.lastError;
			},
		);
		expect(lastError).toBeNull();
		expect(graphQLRequests).toBe(Math.ceil(zoneCount / 10));

		await evictDurableObject(stub);
		const snapshot = await stub.exportPackedColoMetrics();
		expect(
			snapshot?.zones.reduce((total, zone) => total + zone.colo.length, 0),
		).toBe(zoneCount * rowsPerZone);
		for (const zone of snapshot?.zones ?? []) {
			expect(zone.visits.every((value) => value === sampleValue)).toBe(true);
			expect(
				zone.edgeResponseBytes.every((value) => value === sampleValue),
			).toBe(true);
			expect(zone.requests.every((value) => value === sampleValue)).toBe(true);
		}
	});
});
