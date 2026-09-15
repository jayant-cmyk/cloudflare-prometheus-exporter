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
	ADAPTIVE_METRIC_SCENARIOS,
	type AdaptiveMetricScenario,
} from "./scenarios";

const network = setupNetwork();

function createAdaptiveGroups(scenario: AdaptiveMetricScenario) {
	const {
		countriesPerZone,
		hostsPerCountry,
		statusesPerHost,
		trafficPerSeries,
	} = scenario.scale;
	return Array.from({ length: countriesPerZone }, (_, countryIndex) =>
		Array.from({ length: hostsPerCountry }, (_, hostIndex) =>
			Array.from({ length: statusesPerHost }, (_, statusIndex) => ({
				dimensions: {
					originResponseStatus: statusIndex === 0 ? 404 : 500,
					clientCountryName: `COUNTRY-${countryIndex}`,
					clientRequestHTTPHost: `host-${countryIndex}-${hostIndex}.example.com`,
				},
				count: trafficPerSeries.count,
				avg: {
					originResponseDurationMs: trafficPerSeries.avgOriginDurationMs,
				},
			})),
		),
	).flat(2);
}

beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());

describe("adaptive-metrics Durable Object", () => {
	it.each(
		ADAPTIVE_METRIC_SCENARIOS,
	)("$path $name", async (scenario: AdaptiveMetricScenario) => {
		const accountId = scenario.name.replaceAll(" ", "-");
		const zones = Array.from({ length: scenario.scale.zones }, (_, index) => ({
			id: `${accountId}-zone-${index}`,
			name: `${accountId}-zone-${index}.example.com`,
			status: "active",
			plan: { id: "paid", name: "Paid" },
			account: { id: accountId, name: accountId },
		}));
		const groups = createAdaptiveGroups(scenario);
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
		if (snapshot?.queryName !== "adaptive-metrics") {
			throw new Error("expected a packed adaptive snapshot");
		}

		expect(snapshot.zones).toHaveLength(scenario.scale.zones);
		const expectedRows =
			scenario.scale.zones *
			scenario.scale.countriesPerZone *
			scenario.scale.hostsPerCountry *
			scenario.scale.statusesPerHost;
		expect(
			snapshot.zones.reduce((total, zone) => total + zone.status.length, 0),
		).toBe(expectedRows);
		for (const zone of snapshot.zones) {
			expect(zone.status).toHaveLength(
				scenario.scale.countriesPerZone *
					scenario.scale.hostsPerCountry *
					scenario.scale.statusesPerHost,
			);
			expect(
				zone.count.every(
					(value) => value === scenario.scale.trafficPerSeries.count,
				),
			).toBe(true);
			expect(
				zone.avgOriginDurationMs.every(
					(value) =>
						value === scenario.scale.trafficPerSeries.avgOriginDurationMs,
				),
			).toBe(true);
			const perStatus =
				scenario.scale.countriesPerZone *
				scenario.scale.hostsPerCountry *
				scenario.scale.trafficPerSeries.count;
			expect(zone.errors4xx).toBe(perStatus);
			expect(zone.errors5xx).toBe(perStatus);
		}
	});
});
