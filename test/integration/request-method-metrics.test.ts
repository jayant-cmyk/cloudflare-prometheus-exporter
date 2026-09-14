/// <reference types="@cloudflare/vitest-plugin/types" />

import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { setupNetwork } from "@msw/cloudflare";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CLOUDFLARE_GQL_URL } from "../../src/cloudflare/client";
import type { MetricExporter } from "../../src/durable-objects/MetricExporter";
import {
	REQUEST_METHOD_METRIC_SCENARIOS,
	type RequestMethodMetricScenario,
} from "./scenarios";

const network = setupNetwork();

beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());

describe("request-method-metrics Durable Object", () => {
	it.each(
		REQUEST_METHOD_METRIC_SCENARIOS,
	)("$path $name", async (scenario: RequestMethodMetricScenario) => {
		const accountId = scenario.name.replaceAll(" ", "-");
		const zones = Array.from({ length: scenario.scale.zones }, (_, index) => ({
			id: `${accountId}-zone-${index}`,
			name: `${accountId}-zone-${index}.example.com`,
			status: "active",
			plan: { id: "paid", name: "Paid" },
			account: { id: accountId, name: accountId },
		}));
		const groups = Array.from(
			{ length: scenario.scale.methodsPerZone },
			(_, index) => ({
				dimensions: {
					clientRequestHTTPMethodName: `METHOD-${index}`,
				},
				count: scenario.scale.requestsPerMethod,
			}),
		);
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

		const exporterId = `account:${accountId}:${scenario.path.metric}`;
		const stub = env.MetricExporter.getByName(exporterId);
		await stub.initialize(exporterId);
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
		expect(graphQLRequests).toBe(Math.ceil(scenario.scale.zones / 10));

		await evictDurableObject(stub);
		const snapshot = await stub.exportPackedMetrics();
		if (snapshot?.queryName !== "request-method-metrics") {
			throw new Error("expected a packed request method snapshot");
		}

		expect(snapshot.zones).toHaveLength(scenario.scale.zones);
		const expectedRows = scenario.scale.zones * scenario.scale.methodsPerZone;
		expect(
			snapshot.zones.reduce((total, zone) => total + zone.rows.length, 0),
		).toBe(expectedRows);
		for (const zone of snapshot.zones) {
			expect(zone.rows).toHaveLength(scenario.scale.methodsPerZone);
			expect(
				zone.rows.every(
					(row) => row.count === scenario.scale.requestsPerMethod,
				),
			).toBe(true);
		}
	});
});
