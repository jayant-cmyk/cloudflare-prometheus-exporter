import { describe, expect, it } from "vitest";
import type { MetricDefinition } from "./metrics";
import { serializePackedLbWeightMetrics } from "./packed-lb-weight-prometheus";
import type { PackedLbWeightMetricState } from "./packed-lb-weight-state";
import { serializeToPrometheus } from "./prometheus";

type Row = {
	lbName: string;
	poolName: string;
	originName: string;
	weight: number;
};

function packedState(
	rows: Row[],
	zone = "example.com",
): PackedLbWeightMetricState {
	return {
		format: "lb-weight-packed-by-zone-v1",
		accountId: "account-id",
		accountName: "Account",
		queryName: "lb-weight-metrics",
		lastFetch: 1,
		lastIngest: 1,
		zones: [{ zone, rows }],
	};
}

function unpacked(rows: Row[], zone = "example.com"): MetricDefinition[] {
	return [
		{
			name: "cloudflare_zone_lb_origin_weight",
			help: "Load balancer origin weight (0-1 normalized)",
			type: "gauge",
			values: rows.map((row) => ({
				labels: {
					zone,
					lb_name: row.lbName,
					pool_name: row.poolName,
					origin_name: row.originName,
				},
				value: row.weight,
			})),
		},
	];
}

function serialize(states: PackedLbWeightMetricState[]): string {
	return [...serializePackedLbWeightMetrics(states, {})].join("");
}

describe("serializePackedLbWeightMetrics", () => {
	it("matches legacy output", () => {
		const rows: Row[] = [
			{
				lbName: "public",
				poolName: "primary",
				originName: "app-1",
				weight: 0.75,
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
