import { describe, expect, it } from "vitest";
import type { MetricDefinition } from "./metrics";
import {
	accumulatePackedOriginStatusRows,
	type PackedOriginStatusMetricState,
	PackedOriginStatusMetricStateSchema,
} from "./packed-origin-status-state";

const METRIC_NAME = "cloudflare_zone_requests_origin_status_country_host_total";

type Row = {
	zone?: string;
	originStatus: string;
	country: string;
	host: string;
	value: number;
};

function window(rows: Row[]): MetricDefinition[] {
	return [
		{
			name: METRIC_NAME,
			help: "Requests by origin status, country, and host",
			type: "counter",
			values: rows.map((row) => ({
				labels: {
					zone: row.zone ?? "example.com",
					origin_status: row.originStatus,
					country: row.country,
					host: row.host,
				},
				value: row.value,
			})),
		},
	];
}

function state(
	zones: PackedOriginStatusMetricState["zones"],
	lastIngest: number,
): PackedOriginStatusMetricState {
	return {
		format: "origin-status-packed-by-zone-v1",
		accountId: "account-id",
		accountName: "Account",
		queryName: "origin-status-metrics",
		lastFetch: 1,
		lastIngest,
		zones,
	};
}

describe("accumulatePackedOriginStatusRows", () => {
	it("keeps one row per status, country and host combination", () => {
		const zones = accumulatePackedOriginStatusRows(
			undefined,
			window([
				{ originStatus: "200", country: "US", host: "a.example.com", value: 1 },
				{ originStatus: "200", country: "DE", host: "a.example.com", value: 2 },
				{ originStatus: "502", country: "US", host: "a.example.com", value: 3 },
				{ originStatus: "502", country: "US", host: "b.example.com", value: 4 },
				{
					zone: "other.com",
					originStatus: "200",
					country: "US",
					host: "c.example.com",
					value: 5,
				},
			]),
			1,
			new Set(),
		);

		expect(zones).toHaveLength(2);
		expect(zones[0]).toMatchObject({
			zone: "example.com",
			originStatus: ["200", "200", "502", "502"],
			country: ["US", "DE", "US", "US"],
			host: [
				"a.example.com",
				"a.example.com",
				"a.example.com",
				"b.example.com",
			],
			requests: [1, 2, 3, 4],
		});
		expect(zones[1]).toMatchObject({ zone: "other.com", requests: [5] });
		expect(
			PackedOriginStatusMetricStateSchema.safeParse(state(zones, 1)).success,
		).toBe(true);
	});

	it("sums duplicate groups that share a key tuple", () => {
		const zones = accumulatePackedOriginStatusRows(
			undefined,
			window([
				{ originStatus: "200", country: "US", host: "a.example.com", value: 2 },
				{ originStatus: "200", country: "US", host: "a.example.com", value: 3 },
			]),
			1,
			new Set(),
		);

		expect(zones[0]).toMatchObject({ requests: [5] });
	});

	it("accumulates across windows and ignores a replayed window", () => {
		const first = accumulatePackedOriginStatusRows(
			undefined,
			window([
				{
					originStatus: "200",
					country: "US",
					host: "a.example.com",
					value: 10,
				},
			]),
			1,
			new Set(),
		);
		const second = accumulatePackedOriginStatusRows(
			state(first, 1),
			window([
				{
					originStatus: "200",
					country: "US",
					host: "a.example.com",
					value: 10,
				},
			]),
			2,
			new Set(),
		);
		expect(second[0]).toMatchObject({ requests: [20], lastIngest: [2] });

		// A retry of window 2 must not double-count.
		const retried = accumulatePackedOriginStatusRows(
			state(second, 2),
			window([
				{
					originStatus: "200",
					country: "US",
					host: "a.example.com",
					value: 10,
				},
			]),
			2,
			new Set(),
		);
		expect(retried[0]).toMatchObject({ requests: [20] });
	});

	it("expires rows absent for five windows, aging once per window", () => {
		let zones = accumulatePackedOriginStatusRows(
			undefined,
			window([
				{ originStatus: "200", country: "US", host: "a.example.com", value: 1 },
			]),
			1,
			new Set(),
		);
		let previous = state(zones, 1);

		zones = accumulatePackedOriginStatusRows(previous, [], 2, new Set());
		expect(zones[0]).toMatchObject({ misses: [4], requests: [1] });

		// Replaying window 2 must not age the row a second time.
		zones = accumulatePackedOriginStatusRows(state(zones, 2), [], 2, new Set());
		expect(zones[0]).toMatchObject({ misses: [4] });

		previous = state(zones, 2);
		for (let ingestId = 3; ingestId <= 6; ingestId++) {
			zones = accumulatePackedOriginStatusRows(
				previous,
				[],
				ingestId,
				new Set(),
			);
			previous = state(zones, ingestId);
		}
		expect(zones).toEqual([]);
	});

	it("does not age rows whose zone failed this refresh", () => {
		const first = accumulatePackedOriginStatusRows(
			undefined,
			window([
				{ originStatus: "200", country: "US", host: "a.example.com", value: 1 },
			]),
			1,
			new Set(),
		);
		const zones = accumulatePackedOriginStatusRows(
			state(first, 1),
			[],
			2,
			new Set(["example.com"]),
		);

		expect(zones[0]).toMatchObject({ misses: [5], lastIngest: [1] });
	});

	it("returns no zones for an empty window", () => {
		expect(
			accumulatePackedOriginStatusRows(undefined, [], 1, new Set()),
		).toEqual([]);
		expect(
			accumulatePackedOriginStatusRows(undefined, window([]), 1, new Set()),
		).toEqual([]);
	});
});
