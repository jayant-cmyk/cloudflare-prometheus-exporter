import { describe, expect, it } from "vitest";
import type { MetricDefinition } from "./metrics";
import { serializePackedLogpushZoneMetrics } from "./packed-logpush-zone-prometheus";
import type { PackedLogpushZoneMetricState } from "./packed-logpush-zone-state";
import { serializeToPrometheus } from "./prometheus";

type Row = {
	jobId: string;
	destinationType: string;
	count: number;
};

function packedState(
	rows: Row[],
	zone = "example.com",
): PackedLogpushZoneMetricState {
	return {
		format: "logpush-zone-packed-by-zone-v1",
		accountId: "account-id",
		accountName: "Account",
		queryName: "logpush-zone",
		lastFetch: 1,
		lastIngest: 1,
		zones: [{ zone, rows }],
	};
}

function unpacked(rows: Row[], zone = "example.com"): MetricDefinition[] {
	return [
		{
			name: "cloudflare_logpush_failed_jobs_zone_total",
			help: "Failed logpush jobs per zone",
			type: "counter",
			values: rows.map((row) => ({
				labels: {
					zone,
					job_id: row.jobId,
					destination_type: row.destinationType,
				},
				value: row.count,
			})),
		},
	];
}

function serialize(states: PackedLogpushZoneMetricState[]): string {
	return [...serializePackedLogpushZoneMetrics(states, {})].join("");
}

describe("serializePackedLogpushZoneMetrics", () => {
	it("matches legacy output", () => {
		const rows: Row[] = [
			{ jobId: "1", destinationType: "s3", count: 2 },
			{ jobId: "2", destinationType: "r2", count: 5 },
		];

		expect(serialize([packedState(rows)])).toBe(
			`${serializeToPrometheus(unpacked(rows))}\n`,
		);
	});

	it("omits empty snapshots", () => {
		expect(serialize([packedState([])])).toBe("");
	});
});
