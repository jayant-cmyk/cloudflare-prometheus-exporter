import { afterEach, describe, expect, it, vi } from "vitest";
import type { MetricDefinition } from "../lib/metrics";
import { serializeToPrometheus } from "../lib/prometheus";
import { MetricCoordinator } from "./MetricCoordinator";
import type {
	PackedColoMetricRow,
	PackedColoMetricState,
} from "./MetricExporter";

const requestsName = "cloudflare_zone_colocation_requests_total";

function packedRow(host: string, value = 10): PackedColoMetricRow {
	return {
		colo: "SJC",
		host,
		visits: value,
		edgeResponseBytes: value,
		requests: value,
		visitsMisses: 5,
		edgeResponseBytesMisses: 5,
		requestsMisses: 5,
		visitsLastIngest: 1,
		edgeResponseBytesLastIngest: 1,
		requestsLastIngest: 1,
	};
}

function packedState(rows: PackedColoMetricRow[]): PackedColoMetricState {
	return {
		format: "colo-packed-by-zone-v1",
		accountId: "account-a",
		accountName: "Account",
		queryName: "colo-metrics",
		lastFetch: 1,
		lastIngest: 1,
		zones: [{ zone: "example.com", rows }],
	};
}

function expectedMetrics(state: PackedColoMetricState): MetricDefinition[] {
	return (
		[
			{
				name: "cloudflare_zone_colocation_visits_total",
				help: "Visits per colo",
				field: "visits",
				misses: "visitsMisses",
			},
			{
				name: "cloudflare_zone_colocation_edge_response_bytes_total",
				help: "Edge response bytes per colo",
				field: "edgeResponseBytes",
				misses: "edgeResponseBytesMisses",
			},
			{
				name: requestsName,
				help: "Requests per colo",
				field: "requests",
				misses: "requestsMisses",
			},
		] as const
	).map(({ name, help, field, misses }) => ({
		name,
		help,
		type: "counter" as const,
		values: state.zones.flatMap((zone) =>
			zone.rows
				.filter((row) => row[misses] > 0)
				.map((row) => ({
					labels: { zone: zone.zone, colo: row.colo, host: row.host },
					value: row[field],
				})),
		),
	}));
}

async function createCoordinator(
	packed: PackedColoMetricState[],
	legacy: MetricDefinition[] = [],
	overrides: { excludeHost?: boolean; metricsDenylist?: string } = {},
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
				exportForPrometheus: async () => ({
					metrics: id === "account:account-a" ? [] : legacy,
					packedColoMetrics: id === "account:account-a" ? packed : [],
					zoneCounts: {
						total: 1,
						filtered: 1,
						processed: 1,
						skippedFreeTier: 0,
					},
				}),
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
		const state = packedState([
			packedRow('www.\\\\"\nexample.com'),
			packedRow("other.example.com", 20),
		]);
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
				serializeToPrometheus(expectedMetrics(state), {
					excludeLabels: excludeHost ? new Set(["host"]) : undefined,
					denylist: new Set([requestsName]),
				}),
			),
		);
	});

	it("matches numeric formatting and omits expired counters", async () => {
		const state = packedState([
			...[
				0,
				Number.NaN,
				Number.POSITIVE_INFINITY,
				Number.NEGATIVE_INFINITY,
			].map((value, index) => packedRow(`host-${index}.example.com`, value)),
			{ ...packedRow("expired.example.com"), requestsMisses: 0 },
		]);
		const coordinator = await createCoordinator([state]);
		const response = await coordinator.fetch(
			new Request("https://test/export"),
		);
		expect(coloOutput(await response.text())).toEqual(
			coloOutput(serializeToPrometheus(expectedMetrics(state))),
		);
	});

	it("does not serialize the whole packed snapshot before a slow reader consumes it", async () => {
		let visitsRead = 0;
		const rows = Array.from({ length: 5000 }, (_, index) => ({
			...packedRow(`host-${index}.example.com`),
			get visits() {
				visitsRead++;
				return 10;
			},
		}));
		const coordinator = await createCoordinator([packedState(rows)]);
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
});
