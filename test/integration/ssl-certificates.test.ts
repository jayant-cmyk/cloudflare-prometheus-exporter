/// <reference types="@cloudflare/vitest-plugin/types" />

import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCloudflareMetricsClient } from "../../src/cloudflare/client";
import type { MetricExporter } from "../../src/durable-objects/MetricExporter";
import {
	SSL_CERTIFICATE_METRIC_SCENARIOS,
	type SSLCertificateMetricScenario,
} from "./scenarios";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ssl-certificates Durable Object", () => {
	it.each(
		SSL_CERTIFICATE_METRIC_SCENARIOS,
	)("$path $name", async (scenario: SSLCertificateMetricScenario) => {
		const accountId = scenario.name.replaceAll(" ", "-");
		const zone = {
			id: `${accountId}-zone-0`,
			name: `${accountId}-zone-0.example.com`,
			status: "active",
			plan: { id: "paid", name: "Paid" },
			account: { id: accountId, name: accountId },
		};
		const certs = Array.from(
			{ length: scenario.scale.certificatesPerZone },
			(_, index) => ({
				id: `cert-${index}`,
				type: index % 2 === 0 ? "advanced" : "dedicated",
				status: "active",
				issuer: `issuer-${index}`,
				expiresOn: new Date(1_735_689_600_000 + index * 1_000).toISOString(),
				hosts: [zone.name],
			}),
		);

		const client = getCloudflareMetricsClient(env);
		const getSSLCertificates = vi
			.spyOn(client, "getSSLCertificates")
			.mockResolvedValue(certs);

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
		expect(getSSLCertificates).toHaveBeenCalledOnce();

		await evictDurableObject(stub);
		const snapshot = await stub.exportPackedMetrics();
		if (snapshot?.queryName !== "ssl-certificates") {
			throw new Error("expected a packed ssl certificate snapshot");
		}

		expect(snapshot.zones).toEqual([
			{
				zone: zone.name,
				rows: certs.map((cert, index) => ({
					type: cert.type,
					issuer: cert.issuer,
					status: cert.status,
					expiresOnSeconds: 1_735_689_600 + index,
				})),
			},
		]);
	});
});
