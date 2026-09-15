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
	LOGPUSH_ZONE_METRIC_SCENARIOS,
	type LogpushZoneMetricScenario,
} from "./scenarios";

const network = setupNetwork();

function createLogpushGroups(scenario: LogpushZoneMetricScenario) {
	return Array.from({ length: scenario.scale.jobsPerZone }, (_, index) => ({
		dimensions: {
			jobId: index + 1,
			destinationType: index % 2 === 0 ? "s3" : "r2",
		},
		count: scenario.scale.failureCount,
	}));
}

beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());

describe("logpush-zone Durable Object", () => {
	it.each(
		LOGPUSH_ZONE_METRIC_SCENARIOS,
	)("$path $name", async (scenario: LogpushZoneMetricScenario) => {
		const accountId = scenario.name.replaceAll(" ", "-");
		const zones = Array.from({ length: scenario.scale.zones }, (_, index) => ({
			id: `${accountId}-zone-${index}`,
			name: `${accountId}-zone-${index}.example.com`,
			status: "active",
			plan: { id: "paid", name: "Paid" },
			account: { id: accountId, name: accountId },
		}));
		const groups = createLogpushGroups(scenario);
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
									logpushHealthAdaptiveGroups: groups,
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
		if (snapshot?.queryName !== "logpush-zone") {
			throw new Error("expected a packed logpush zone snapshot");
		}

		expect(snapshot.zones).toHaveLength(scenario.scale.zones);
		expect(
			snapshot.zones.reduce((total, zone) => total + zone.rows.length, 0),
		).toBe(scenario.scale.zones * scenario.scale.jobsPerZone);
		for (const zone of snapshot.zones) {
			expect(zone.rows).toHaveLength(scenario.scale.jobsPerZone);
			expect(
				zone.rows.every((row) => row.count === scenario.scale.failureCount),
			).toBe(true);
		}
	});
});
