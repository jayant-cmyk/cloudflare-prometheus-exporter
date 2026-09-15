import { describe, expect, it } from "vitest";
import type { MetricDefinition } from "./metrics";
import { serializePackedAdaptiveMetrics } from "./packed-adaptive-prometheus";
import type { PackedAdaptiveMetricState } from "./packed-adaptive-state";
import { serializeToPrometheus } from "./prometheus";

type Row = {
	status: string;
	country: string;
	host: string;
	count: number;
	avgOriginDurationMs: number | null;
};

function packedState(
	rows: Row[],
	stats = { errors4xx: 0, errors5xx: 0 },
	zone = "example.com",
): PackedAdaptiveMetricState {
	return {
		format: "adaptive-packed-by-zone-v1",
		accountId: "account-id",
		accountName: "Account",
		queryName: "adaptive-metrics",
		lastFetch: 1,
		lastIngest: 1,
		zones: [
			{
				zone,
				status: rows.map((row) => row.status),
				country: rows.map((row) => row.country),
				host: rows.map((row) => row.host),
				count: rows.map((row) => row.count),
				avgOriginDurationMs: rows.map((row) => row.avgOriginDurationMs),
				errors4xx: stats.errors4xx,
				errors5xx: stats.errors5xx,
			},
		],
	};
}

function unpacked(
	rows: Row[],
	stats = { errors4xx: 0, errors5xx: 0 },
	zone = "example.com",
): MetricDefinition[] {
	const error4xx = {
		name: "cloudflare_zone_customer_error_4xx_total",
		help: "4xx error requests",
		type: "counter" as const,
		values: rows
			.filter((row) => Number(row.status) >= 400 && Number(row.status) < 500)
			.filter((row) => row.count > 0)
			.map((row) => ({
				labels: {
					zone,
					status: row.status,
					country: row.country,
					host: row.host,
				},
				value: row.count,
			})),
	};
	const error5xx = {
		name: "cloudflare_zone_customer_error_5xx_total",
		help: "5xx error requests",
		type: "counter" as const,
		values: rows
			.filter((row) => Number(row.status) >= 500)
			.filter((row) => row.count > 0)
			.map((row) => ({
				labels: {
					zone,
					status: row.status,
					country: row.country,
					host: row.host,
				},
				value: row.count,
			})),
	};
	const duration = {
		name: "cloudflare_zone_origin_response_duration_seconds",
		help: "Origin response duration in seconds",
		type: "gauge" as const,
		values: rows
			.filter((row) => row.avgOriginDurationMs != null)
			.map((row) => ({
				labels: {
					zone,
					status: row.status,
					country: row.country,
					host: row.host,
				},
				value: (row.avgOriginDurationMs ?? 0) / 1000,
			})),
	};
	const total = stats.errors4xx + stats.errors5xx;
	const rate = {
		name: "cloudflare_zone_origin_error_rate",
		help: "Origin error rate (4xx+5xx / total origin errors)",
		type: "gauge" as const,
		values:
			total > 0 ? [{ labels: { zone }, value: stats.errors5xx / total }] : [],
	};

	return [error4xx, error5xx, duration, rate].filter(
		(metric) => metric.values.length > 0,
	);
}

function serialize(
	states: PackedAdaptiveMetricState[],
	options: Parameters<typeof serializePackedAdaptiveMetrics>[1] = {},
): string {
	return [...serializePackedAdaptiveMetrics(states, options)].join("");
}

describe("serializePackedAdaptiveMetrics", () => {
	it("matches legacy output including derived error rate", () => {
		const rows: Row[] = [
			{
				status: "404",
				country: "US",
				host: "a.example.com",
				count: 3,
				avgOriginDurationMs: 1200,
			},
			{
				status: "500",
				country: "DE",
				host: "b.example.com",
				count: 2,
				avgOriginDurationMs: 900,
			},
		];
		const stats = { errors4xx: 3, errors5xx: 2 };

		expect(serialize([packedState(rows, stats)])).toBe(
			`${serializeToPrometheus(unpacked(rows, stats))}\n`,
		);
	});

	it("matches legacy aggregation when host is excluded", () => {
		const rows: Row[] = [
			{
				status: "404",
				country: "US",
				host: "a.example.com",
				count: 3,
				avgOriginDurationMs: 500,
			},
			{
				status: "404",
				country: "US",
				host: "b.example.com",
				count: 2,
				avgOriginDurationMs: 900,
			},
		];
		const stats = { errors4xx: 5, errors5xx: 0 };
		const options = { excludeLabels: new Set(["host"]) };

		expect(serialize([packedState(rows, stats)], options)).toBe(
			`${serializeToPrometheus(unpacked(rows, stats), options)}\n`,
		);
	});

	it("omits empty snapshots", () => {
		expect(serialize([packedState([])])).toBe("");
	});
});
