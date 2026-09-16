import { afterEach, describe, expect, it, vi } from "vitest";
import type { MetricDefinition } from "../lib/metrics";
import {
	accumulatePackedMetricState,
	type PackedMetricState,
} from "../lib/packed-metric-state";
import { serializeToPrometheus } from "../lib/prometheus";
import { MetricCoordinator } from "./MetricCoordinator";

const requestsName = "cloudflare_zone_colocation_requests_total";

type Row = { host: string; value: number };

function expectedMetrics(rows: Row[]): MetricDefinition[] {
	return (
		[
			["cloudflare_zone_colocation_visits_total", "Visits per colo"],
			[
				"cloudflare_zone_colocation_edge_response_bytes_total",
				"Edge response bytes per colo",
			],
			[requestsName, "Requests per colo"],
		] as const
	).map(([name, help]) => ({
		name,
		help,
		type: "counter" as const,
		values: rows.map((row) => ({
			labels: { zone: "example.com", colo: "SJC", host: row.host },
			value: row.value,
		})),
	}));
}

function packedState(rows: Row[]): PackedMetricState {
	return accumulatePackedMetricState({
		previous: undefined,
		metrics: expectedMetrics(rows),
		ingestId: 1,
		failedScopes: new Set(),
	});
}

async function createCoordinator(
	packedStates: PackedMetricState[],
	legacy: MetricDefinition[] = [],
	overrides: {
		excludeHost?: boolean;
		metricsDenylist?: string;
		coloMetricsPackedStorage?: boolean;
	} = {},
) {
	let ready = Promise.resolve();
	const ctx = {
		storage: {
			get: async () => ({
				identifier: "metric-coordinator",
				lastAccountFetch: Date.now(),
				accounts: [
					{ id: "account-a", name: "A" },
					{ id: "account-b", name: "B" },
				],
			}),
		},
		blockConcurrencyWhile(callback: () => Promise<void>) {
			ready = callback();
		},
	};
	const env = {
		LOG_LEVEL: "error",
		LOG_FORMAT: "json",
		CONFIG_KV: {
			get: async () =>
				JSON.stringify({ coloMetricsPackedStorage: true, ...overrides }),
		},
		AccountMetricCoordinator: {
			getByName: (id: string) => ({
				initialize: async () => {},
				// Mirrors AccountMetricCoordinator: the caller's mode decides which
				// representation packed metrics use for this scrape.
				exportForPrometheus: async (options: {
					packedMetricQueries: readonly string[];
				}) => {
					const packedStorage =
						options.packedMetricQueries.includes("colo-metrics");
					return {
						metrics: id === "account:account-a" || packedStorage ? [] : legacy,
						packedMetricStates:
							id === "account:account-a" && packedStorage ? packedStates : [],
						zoneCounts: {
							total: 1,
							filtered: 1,
							processed: 1,
							skippedFreeTier: 0,
						},
					};
				},
			}),
		},
	};
	// SAFETY: The runtime shim uses only these storage/config/RPC operations. Worker
	// platform types also require native bindings unavailable in this Node harness.
	const coordinator = new MetricCoordinator(
		ctx as unknown as DurableObjectState,
		env as unknown as Env,
	);
	await ready;
	return coordinator;
}

function coloOutput(output: string): string[] {
	return output
		.split("\n")
		.filter((line) => line.includes("cloudflare_zone_colocation_"))
		.sort();
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("MetricCoordinator packed colo output", () => {
	it.each([
		false,
		true,
	])("matches legacy serialization including escaping and excludeHost=%s", async (excludeHost) => {
		const rows = [
			{ host: 'www.\\\\"\nexample.com', value: 10 },
			{ host: "other.example.com", value: 20 },
		];
		const state = packedState(rows);
		const coordinator = await createCoordinator([state], [], {
			excludeHost,
			metricsDenylist: requestsName,
		});
		const response = await coordinator.fetch(
			new Request("https://test/export"),
		);
		expect(response.status).toBe(200);
		expect(coloOutput(await response.text())).toEqual(
			coloOutput(
				serializeToPrometheus(expectedMetrics(rows), {
					excludeLabels: excludeHost ? new Set(["host"]) : undefined,
					denylist: new Set([requestsName]),
				}),
			),
		);
	});

	it("matches numeric formatting for NaN and infinities", async () => {
		const state = packedState(
			[0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY].map(
				(value, index) => ({ host: `host-${index}.example.com`, value }),
			),
		);
		const coordinator = await createCoordinator([state]);
		const response = await coordinator.fetch(
			new Request("https://test/export"),
		);
		expect(coloOutput(await response.text())).toEqual(
			coloOutput(
				serializeToPrometheus(
					expectedMetrics(
						[
							0,
							Number.NaN,
							Number.POSITIVE_INFINITY,
							Number.NEGATIVE_INFINITY,
						].map((value, index) => ({
							host: `host-${index}.example.com`,
							value,
						})),
					),
				),
			),
		);
	});

	it("does not serialize the whole packed snapshot before a slow reader consumes it", async () => {
		let visitsRead = 0;
		const rows = Array.from({ length: 5000 }, (_, index) => ({
			host: `host-${index}.example.com`,
			value: 10,
		}));
		const state = packedState(rows);
		const visits = state.zones[0]?.families[0];
		if (visits === undefined) throw new Error("fixture has no visits table");
		visits.values = new Proxy(visits.values, {
			get(target, property, receiver) {
				if (typeof property === "string" && /^\d+$/.test(property))
					visitsRead++;
				return Reflect.get(target, property, receiver);
			},
		});
		const coordinator = await createCoordinator([state]);
		const response = await coordinator.fetch(
			new Request("https://test/export"),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(visitsRead).toBeLessThan(rows.length);
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		const first = await reader?.read();
		expect(first?.value?.byteLength).toBeLessThan(66 * 1024);
		await reader?.cancel();
		const readsAtCancel = visitsRead;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(visitsRead).toBe(readsAtCancel);
	});

	it("passes one storage mode to every account so HELP/TYPE appear once", async () => {
		const legacy = expectedMetrics([{ host: "b.example.com", value: 1 }]);
		for (const coloMetricsPackedStorage of [true, false]) {
			const coordinator = await createCoordinator(
				[packedState([{ host: "a.example.com", value: 1 }])],
				legacy,
				{ coloMetricsPackedStorage },
			);
			const text = await (
				await coordinator.fetch(new Request("https://test/export"))
			).text();
			expect(
				text.match(/^# HELP cloudflare_zone_colocation_requests_total/gm),
			).toHaveLength(1);
			expect(
				text.match(/^# TYPE cloudflare_zone_colocation_requests_total/gm),
			).toHaveLength(1);
		}
	});
});
