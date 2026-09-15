import { describe, expect, it } from "vitest";
import type { MetricDefinition } from "./metrics";
import { serializePackedColoErrorMetrics } from "./packed-colo-error-prometheus";
import type { PackedColoErrorMetricState } from "./packed-colo-error-state";
import { serializeToPrometheus } from "./prometheus";

type Row = {
	colo: string;
	host: string;
	status: string;
	visits: number;
	edgeResponseBytes: number;
	requests: number;
};

function packedState(
	rows: Row[],
	zone = "example.com",
): PackedColoErrorMetricState {
	return {
		format: "colo-error-packed-by-zone-v1",
		accountId: "account-id",
		accountName: "Account",
		queryName: "colo-error-metrics",
		lastFetch: 1,
		lastIngest: 1,
		zones: [
			{
				zone,
				colo: rows.map((row) => row.colo),
				host: rows.map((row) => row.host),
				status: rows.map((row) => row.status),
				visits: rows.map((row) => row.visits),
				edgeResponseBytes: rows.map((row) => row.edgeResponseBytes),
				requests: rows.map((row) => row.requests),
				misses: rows.map(() => 0),
				lastIngest: rows.map(() => 1),
			},
		],
	};
}

function unpacked(rows: Row[], zone = "example.com"): MetricDefinition[] {
	return [
		{
			name: "cloudflare_zone_colocation_error_visits_total",
			help: "Error visits per colo",
			type: "counter",
			values: rows.map((row) => ({
				labels: { zone, colo: row.colo, host: row.host, status: row.status },
				value: row.visits,
			})),
		},
		{
			name: "cloudflare_zone_colocation_error_edge_response_bytes_total",
			help: "Error response bytes per colo",
			type: "counter",
			values: rows.map((row) => ({
				labels: { zone, colo: row.colo, host: row.host, status: row.status },
				value: row.edgeResponseBytes,
			})),
		},
		{
			name: "cloudflare_zone_colocation_error_requests_total",
			help: "Error requests per colo",
			type: "counter",
			values: rows.map((row) => ({
				labels: { zone, colo: row.colo, host: row.host, status: row.status },
				value: row.requests,
			})),
		},
	];
}

function serialize(states: PackedColoErrorMetricState[]): string {
	return [...serializePackedColoErrorMetrics(states, {})].join("");
}

describe("serializePackedColoErrorMetrics", () => {
	it("matches legacy output", () => {
		const rows: Row[] = [
			{
				colo: "SJC",
				host: "a.example.com",
				status: "500",
				visits: 2,
				edgeResponseBytes: 256,
				requests: 3,
			},
		];

		expect(serialize([packedState(rows)])).toBe(
			`${serializeToPrometheus(unpacked(rows))}\n`,
		);
	});

	it("omits empty snapshots", () => {
		expect(serialize([packedState([])])).toBe("");
	});
});
