/// <reference types="@cloudflare/vitest-plugin/types" />

import { describe, expect, it } from "vitest";
import {
	createPaidZone,
	exportSuccessfulSnapshot,
	initializeMetricExporter,
	mockBatchedZoneGroups,
	setupGraphQLNetwork,
} from "./metric-exporter-helpers";
import { COLO_METRIC_SCENARIOS, type ColoMetricScenario } from "./scenarios";

const network = setupGraphQLNetwork();

function createColoGroups(scenario: ColoMetricScenario) {
	const { colosPerZone, hostsPerColo, trafficPerHost } = scenario.scale;
	return Array.from({ length: colosPerZone }, (_, coloIndex) =>
		Array.from({ length: hostsPerColo }, (_, hostIndex) => ({
			dimensions: {
				coloCode: `COLO-${coloIndex}`,
				clientRequestHTTPHost: `host-${coloIndex}-${hostIndex}.example.com`,
			},
			count: trafficPerHost.requests,
			sum: {
				visits: trafficPerHost.visits,
				edgeResponseBytes: trafficPerHost.responseBytes,
			},
		})),
	).flat();
}

describe("colo-metrics Durable Object", () => {
	it.each(COLO_METRIC_SCENARIOS)("$name", async (scenario) => {
		const accountId = scenario.name.replaceAll(" ", "-");
		const zones = Array.from({ length: scenario.scale.zones }, (_, index) =>
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

		expect(graphQLRequests()).toBe(Math.ceil(scenario.scale.zones / 10));
		if (snapshot?.format !== "colo-packed-by-zone-v2") {
			throw new Error("expected a colo-metrics snapshot");
		}
		const expectedRecords =
			scenario.scale.zones *
			scenario.scale.colosPerZone *
			scenario.scale.hostsPerColo;
		expect(
			snapshot.zones.reduce((total, zone) => total + zone.colo.length, 0),
		).toBe(expectedRecords);
		for (const zone of snapshot.zones) {
			expect(
				zone.visits.every(
					(value) => value === scenario.scale.trafficPerHost.visits,
				),
			).toBe(true);
			expect(
				zone.edgeResponseBytes.every(
					(value) => value === scenario.scale.trafficPerHost.responseBytes,
				),
			).toBe(true);
			expect(
				zone.requests.every(
					(value) => value === scenario.scale.trafficPerHost.requests,
				),
			).toBe(true);
		}
	});
});
