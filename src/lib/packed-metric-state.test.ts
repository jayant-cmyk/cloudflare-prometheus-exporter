import { describe, expect, it, vi } from "vitest";
import type { MetricDefinition } from "./metrics";
import {
	accumulatePackedMetricState,
	isPackedMetricQuery,
	PACKED_METRIC_QUERIES,
	packedMetricScopes,
	packedMetricStateKey,
	packedMetricStorageEnabled,
} from "./packed-metric-state";

const coloLabels = {
	zone: "example.com",
	colo: "SJC",
	host: "www.example.com",
};

const coloMetrics: MetricDefinition[] = [
	{
		name: "cloudflare_zone_colocation_visits_total",
		help: "Visits per colo",
		type: "counter",
		values: [{ labels: coloLabels, value: 2 }],
	},
	{
		name: "cloudflare_zone_colocation_edge_response_bytes_total",
		help: "Edge response bytes per colo",
		type: "counter",
		values: [{ labels: coloLabels, value: 3 }],
	},
	{
		name: "cloudflare_zone_colocation_requests_total",
		help: "Requests per colo",
		type: "counter",
		values: [{ labels: coloLabels, value: 4 }],
	},
];

const originStatusMetrics: MetricDefinition[] = [
	{
		name: "cloudflare_zone_requests_origin_status_country_host_total",
		help: "Requests by origin status, country, and host",
		type: "counter",
		values: [
			{
				labels: {
					zone: "example.com",
					origin_status: "200",
					country: "US",
					host: "www.example.com",
				},
				value: 7,
			},
		],
	},
];

describe("packed metric state facade", () => {
	it("registers every packed query with the existing colo storage key", () => {
		expect(PACKED_METRIC_QUERIES).toEqual([
			"adaptive-metrics",
			"cache-miss-metrics",
			"colo-error-metrics",
			"colo-metrics",
			"lb-weight-metrics",
			"logpush-zone",
			"origin-status-metrics",
			"request-method-metrics",
			"ssl-certificates",
		]);
		expect(isPackedMetricQuery("adaptive-metrics")).toBe(true);
		expect(isPackedMetricQuery("colo-error-metrics")).toBe(true);
		expect(isPackedMetricQuery("colo-metrics")).toBe(true);
		expect(isPackedMetricQuery("lb-weight-metrics")).toBe(true);
		expect(isPackedMetricQuery("logpush-zone")).toBe(true);
		expect(isPackedMetricQuery("origin-status-metrics")).toBe(true);
		expect(isPackedMetricQuery("request-method-metrics")).toBe(true);
		expect(isPackedMetricQuery("cache-miss-metrics")).toBe(true);
		expect(isPackedMetricQuery("ssl-certificates")).toBe(true);
		for (const query of PACKED_METRIC_QUERIES) {
			expect(packedMetricStateKey(query)).toBe("packed-colo-metrics");
		}
	});

	it("resolves the shared rollout flag for every packed query", () => {
		for (const query of PACKED_METRIC_QUERIES) {
			expect(
				packedMetricStorageEnabled(query, { packedMetricStorage: true }),
			).toBe(true);
			expect(
				packedMetricStorageEnabled(query, { packedMetricStorage: false }),
			).toBe(false);
		}
	});

	it("dispatches accumulation and scope discovery to the colo codec", () => {
		vi.spyOn(Date, "now").mockReturnValue(123);
		const state = accumulatePackedMetricState({
			queryName: "colo-metrics",
			accountId: "account-id",
			accountName: "Account",
			previous: undefined,
			metrics: coloMetrics,
			ingestId: 10,
			failedScopes: new Set(),
		});

		expect(state).toMatchObject({
			format: "colo-packed-by-zone-v2",
			accountId: "account-id",
			queryName: "colo-metrics",
			lastFetch: 123,
			lastIngest: 10,
		});
		expect(state.zones[0]).toMatchObject({
			zone: "example.com",
			colo: ["SJC"],
			host: ["www.example.com"],
			visits: [2],
			edgeResponseBytes: [3],
			requests: [4],
		});
		expect(packedMetricScopes(state)).toEqual(["example.com"]);
	});

	it("dispatches accumulation and scope discovery to the origin status codec", () => {
		vi.spyOn(Date, "now").mockReturnValue(456);
		const state = accumulatePackedMetricState({
			queryName: "origin-status-metrics",
			accountId: "account-id",
			accountName: "Account",
			previous: undefined,
			metrics: originStatusMetrics,
			ingestId: 20,
			failedScopes: new Set(),
		});

		expect(state).toMatchObject({
			format: "origin-status-packed-by-zone-v1",
			queryName: "origin-status-metrics",
			lastFetch: 456,
			lastIngest: 20,
		});
		expect(state.zones[0]).toMatchObject({
			zone: "example.com",
			originStatus: ["200"],
			country: ["US"],
			host: ["www.example.com"],
			requests: [7],
		});
		expect(packedMetricScopes(state)).toEqual(["example.com"]);
	});

	it("ignores a snapshot left over from a different packed query", () => {
		const colo = accumulatePackedMetricState({
			queryName: "colo-metrics",
			accountId: "account-id",
			accountName: "Account",
			previous: undefined,
			metrics: coloMetrics,
			ingestId: 10,
			failedScopes: new Set(),
		});

		// Seeding the origin status codec with a colo snapshot must not adopt its
		// rows; a mismatched snapshot is treated as absent.
		const state = accumulatePackedMetricState({
			queryName: "origin-status-metrics",
			accountId: "account-id",
			accountName: "Account",
			previous: colo,
			metrics: originStatusMetrics,
			ingestId: 20,
			failedScopes: new Set(),
		});

		expect(state.zones).toHaveLength(1);
		expect(state.zones[0]).toMatchObject({ requests: [7] });
	});

	it("discovers scopes from packed request method rows", () => {
		expect(
			packedMetricScopes({
				format: "request-method-packed-by-zone-v1",
				accountId: "account-id",
				accountName: "Account",
				queryName: "request-method-metrics",
				lastFetch: 1,
				lastIngest: 1,
				zones: [{ zone: "example.com", rows: [{ method: "GET", count: 1 }] }],
			}),
		).toEqual(["example.com"]);
	});

	it("discovers scopes from packed cache miss rows", () => {
		expect(
			packedMetricScopes({
				format: "cache-miss-packed-by-zone-v1",
				accountId: "account-id",
				accountName: "Account",
				queryName: "cache-miss-metrics",
				lastFetch: 1,
				lastIngest: 1,
				zones: [
					{
						zone: "example.com",
						rows: [
							{
								country: "US",
								host: "a.example.com",
								avgOriginDurationMs: 123,
							},
						],
					},
				],
			}),
		).toEqual(["example.com"]);
	});
});
