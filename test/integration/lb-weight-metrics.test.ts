/// <reference types="@cloudflare/vitest-plugin/types" />

import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCloudflareMetricsClient } from "../../src/cloudflare/client";
import type { MetricExporter } from "../../src/durable-objects/MetricExporter";
import {
	LB_WEIGHT_METRIC_SCENARIOS,
	type LbWeightMetricScenario,
} from "./scenarios";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("lb-weight-metrics Durable Object", () => {
	it.each(
		LB_WEIGHT_METRIC_SCENARIOS,
	)("$path $name", async (scenario: LbWeightMetricScenario) => {
		const accountId = scenario.name.replaceAll(" ", "-");
		const zone = {
			id: `${accountId}-zone-0`,
			name: `${accountId}-zone-0.example.com`,
			status: "active",
			plan: { id: "paid", name: "Paid" },
			account: { id: accountId, name: accountId },
		};
		const configs = Array.from(
			{ length: scenario.scale.loadBalancersPerZone },
			(_, lbIndex) => ({
				id: `lb-${lbIndex}`,
				name: `lb-${lbIndex}`,
				pools: Array.from(
					{ length: scenario.scale.poolsPerLoadBalancer },
					(_, poolIndex) => ({
						id: `pool-${lbIndex}-${poolIndex}`,
						name: `pool-${lbIndex}-${poolIndex}`,
						enabled: true,
						origins: Array.from(
							{ length: scenario.scale.originsPerPool },
							(_, originIndex) => ({
								name: `origin-${lbIndex}-${poolIndex}-${originIndex}`,
								address: `192.0.2.${(originIndex % 200) + 1}`,
								enabled: originIndex < scenario.scale.enabledOriginsPerPool,
								weight: scenario.scale.weight,
							}),
						),
					}),
				),
			}),
		);

		const client = getCloudflareMetricsClient(env);
		const getLoadBalancerConfigs = vi
			.spyOn(client, "getLoadBalancerConfigs")
			.mockResolvedValue(configs);

		const exporterId = `zone:${zone.id}:${scenario.path.metric}`;
		const stub = env.MetricExporter.getByName(exporterId);
		await stub.initialize(exporterId);
		await stub.initializeZone(zone, accountId, accountId, {
			mintime: "2026-01-01T00:00:00.000Z",
			maxtime: "2026-01-01T00:01:00.000Z",
		});

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
		expect(getLoadBalancerConfigs).toHaveBeenCalledOnce();

		await evictDurableObject(stub);
		const snapshot = await stub.exportPackedMetrics();
		if (snapshot?.queryName !== "lb-weight-metrics") {
			throw new Error("expected a packed lb weight snapshot");
		}

		expect(snapshot.zones).toHaveLength(1);
		expect(snapshot.zones[0]?.zone).toBe(zone.name);
		expect(snapshot.zones[0]?.rows).toHaveLength(
			scenario.scale.loadBalancersPerZone *
				scenario.scale.poolsPerLoadBalancer *
				scenario.scale.enabledOriginsPerPool,
		);
		expect(
			snapshot.zones[0]?.rows.every(
				(row) => row.weight === scenario.scale.weight,
			),
		).toBe(true);
	});
});
