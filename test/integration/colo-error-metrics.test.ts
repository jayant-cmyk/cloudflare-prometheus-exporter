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
	COLO_ERROR_METRIC_SCENARIOS,
	type ColoErrorMetricScenario,
} from "./scenarios";

const network = setupNetwork();

function createColoErrorGroups(scenario: ColoErrorMetricScenario) {
	const { colosPerZone, hostsPerColo, statusesPerHost, trafficPerSeries } =
		scenario.scale;
	return Array.from({ length: colosPerZone }, (_, coloIndex) =>
		Array.from({ length: hostsPerColo }, (_, hostIndex) =>
			Array.from({ length: statusesPerHost }, (_, statusIndex) => ({
				dimensions: {
					coloCode: `COLO-${coloIndex}`,
					clientRequestHTTPHost: `host-${coloIndex}-${hostIndex}.example.com`,
					edgeResponseStatus: 500 + statusIndex,
				},
				count: trafficPerSeries.requests,
				sum: {
					visits: trafficPerSeries.visits,
					edgeResponseBytes: trafficPerSeries.responseBytes,
				},
			})),
		),
	).flat(2);
}

beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());

describe("colo-error-metrics Durable Object", () => {
	it.each(
		COLO_ERROR_METRIC_SCENARIOS,
	)("$path $name", async (scenario: ColoErrorMetricScenario) => {
		const accountId = scenario.name.replaceAll(" ", "-");
		const zones = Array.from({ length: scenario.scale.zones }, (_, index) => ({
			id: `${accountId}-zone-${index}`,
			name: `${accountId}-zone-${index}.example.com`,
			status: "active",
			plan: { id: "paid", name: "Paid" },
			account: { id: accountId, name: accountId },
		}));
		const groups = createColoErrorGroups(scenario);
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
		if (snapshot?.queryName !== "colo-error-metrics") {
			throw new Error("expected a packed colo error snapshot");
		}

		const expectedRecords =
			scenario.scale.zones *
			scenario.scale.colosPerZone *
			scenario.scale.hostsPerColo *
			scenario.scale.statusesPerHost;
		expect(
			snapshot.zones.reduce((total, zone) => total + zone.colo.length, 0),
		).toBe(expectedRecords);
		for (const zone of snapshot.zones) {
			expect(
				zone.visits.every(
					(value) => value === scenario.scale.trafficPerSeries.visits,
				),
			).toBe(true);
			expect(
				zone.edgeResponseBytes.every(
					(value) => value === scenario.scale.trafficPerSeries.responseBytes,
				),
			).toBe(true);
			expect(
				zone.requests.every(
					(value) => value === scenario.scale.trafficPerSeries.requests,
				),
			).toBe(true);
		}
	});
});
