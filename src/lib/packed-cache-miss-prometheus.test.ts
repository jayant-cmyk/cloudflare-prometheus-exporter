import { describe, expect, it } from "vitest";
import type { MetricDefinition } from "./metrics";
import { serializePackedCacheMissMetrics } from "./packed-cache-miss-prometheus";
import type { PackedCacheMissMetricState } from "./packed-cache-miss-state";
import { serializeToPrometheus } from "./prometheus";

const METRIC_NAME = "cloudflare_zone_cache_miss_origin_duration_seconds";
const HELP = "Average origin response duration on cache miss in seconds";

type Row = {
	country: string;
	host: string;
	avgOriginDurationMs: number;
};

function packedState(
	rows: Row[],
	zone = "example.com",
): PackedCacheMissMetricState {
	return {
		format: "cache-miss-packed-by-zone-v1",
		accountId: "account-id",
		accountName: "Account",
		queryName: "cache-miss-metrics",
		lastFetch: 1,
		lastIngest: 1,
		zones: [{ zone, rows }],
	};
}

function unpacked(rows: Row[], zone = "example.com"): MetricDefinition[] {
	return [
		{
			name: METRIC_NAME,
			help: HELP,
			type: "gauge",
			values: rows.map((row) => ({
				labels: { zone, country: row.country, host: row.host },
				value: row.avgOriginDurationMs / 1000,
			})),
		},
	];
}

function serialize(
	states: PackedCacheMissMetricState[],
	options: Parameters<typeof serializePackedCacheMissMetrics>[1] = {},
): string {
	return [...serializePackedCacheMissMetrics(states, options)].join("");
}

describe("serializePackedCacheMissMetrics", () => {
	it("matches legacy output and converts milliseconds to seconds", () => {
		const rows: Row[] = [
			{
				country: "US",
				host: "a.example.com",
				avgOriginDurationMs: 1250,
			},
			{
				country: "DE",
				host: "b.example.com",
				avgOriginDurationMs: 500,
			},
		];

		expect(serialize([packedState(rows)])).toBe(
			`${serializeToPrometheus(unpacked(rows))}\n`,
		);
	});

	it("matches legacy gauge aggregation when host is excluded", () => {
		const rows: Row[] = [
			{
				country: "US",
				host: "a.example.com",
				avgOriginDurationMs: 500,
			},
			{
				country: "US",
				host: "b.example.com",
				avgOriginDurationMs: 900,
			},
		];
		const options = { excludeLabels: new Set(["host"]) };

		expect(serialize([packedState(rows)], options)).toBe(
			`${serializeToPrometheus(unpacked(rows), options)}\n`,
		);
	});
});
