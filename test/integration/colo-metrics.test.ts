/// <reference types="@cloudflare/vitest-plugin/types" />

import { describe, expect, it } from "vitest";
import {
	createPaidZone,
	exportSuccessfulSnapshot,
	initializeMetricExporter,
	mockBatchedZoneGroups,
	setupGraphQLNetwork,
} from "./metric-exporter-helpers";

const network = setupGraphQLNetwork();

type ColoMetricScenario = (typeof COLO_METRIC_SCENARIOS)[number];

const COLO_METRIC_SCENARIOS = [
	{
		name: "small colo account",
		zones: 1,
		colosPerZone: 10,
		hostsPerColo: 10,
	},
	{
		name: "large colo account",
		zones: 15,
		colosPerZone: 10,
		hostsPerColo: 1_000,
	},
] as const;

function createColoGroups(scenario: ColoMetricScenario) {
	const { colosPerZone, hostsPerColo } = scenario;
	return Array.from({ length: colosPerZone }, (_, coloIndex) =>
		Array.from({ length: hostsPerColo }, (_, hostIndex) => ({
			dimensions: {
				coloCode: `COLO-${coloIndex}`,
				clientRequestHTTPHost: `host-${coloIndex}-${hostIndex}.example.com`,
			},
			count: 10,
			sum: {
				visits: 8,
				edgeResponseBytes: 2_048,
			},
		})),
	).flat();
}

describe("colo-metrics Durable Object", () => {
	it.each(COLO_METRIC_SCENARIOS)("$name", async (scenario) => {
		const accountId = scenario.name.replaceAll(" ", "-");
		const zones = Array.from({ length: scenario.zones }, (_, index) =>
			createPaidZone(accountId, `${accountId}-zone-${index}`),
		);
		const groups = createColoGroups(scenario);
		const graphQLRequests = mockBatchedZoneGroups(
			network,
			zones,
			"httpRequestsAdaptiveGroups",
			groups,
		);
		const snapshot = await exportSuccessfulSnapshot(
			await initializeMetricExporter(accountId, "colo-metrics", zones),
		);

		expect(graphQLRequests()).toBe(Math.ceil(scenario.zones / 10));
		if (snapshot?.format !== "colo-packed-by-zone-v2") {
			throw new Error("expected a colo-metrics snapshot");
		}
		const expectedRecords =
			scenario.zones * scenario.colosPerZone * scenario.hostsPerColo;
		expect(
			snapshot.zones.reduce((total, zone) => total + zone.colo.length, 0),
		).toBe(expectedRecords);
		for (const zone of snapshot.zones) {
			expect(zone.visits.every((value) => value === 8)).toBe(true);
			expect(zone.edgeResponseBytes.every((value) => value === 2_048)).toBe(
				true,
			);
			expect(zone.requests.every((value) => value === 10)).toBe(true);
		}
	});
});
