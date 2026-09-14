import { describe, expect, it } from "vitest";
import type { MetricDefinition } from "./metrics";
import { serializePackedOriginStatusMetrics } from "./packed-origin-status-prometheus";
import type { PackedOriginStatusMetricState } from "./packed-origin-status-state";
import { serializeToPrometheus } from "./prometheus";

const METRIC_NAME = "cloudflare_zone_requests_origin_status_country_host_total";
const HELP = "Requests by origin status, country, and host";

type Row = {
	originStatus: string;
	country: string;
	host: string;
	value: number;
};

function packedState(
	rows: Row[],
	zone = "example.com",
): PackedOriginStatusMetricState {
	return {
		format: "origin-status-packed-by-zone-v1",
		accountId: "account-id",
		accountName: "Account",
		queryName: "origin-status-metrics",
		lastFetch: 1,
		lastIngest: 1,
		zones: [
			{
				zone,
				originStatus: rows.map((row) => row.originStatus),
				country: rows.map((row) => row.country),
				host: rows.map((row) => row.host),
				requests: rows.map((row) => row.value),
				misses: rows.map(() => 5),
				lastIngest: rows.map(() => 1),
			},
		],
	};
}

/** The same rows as the unpacked path would produce them. */
function unpacked(rows: Row[], zone = "example.com"): MetricDefinition[] {
	return [
		{
			name: METRIC_NAME,
			help: HELP,
			type: "counter",
			values: rows.map((row) => ({
				labels: {
					zone,
					origin_status: row.originStatus,
					country: row.country,
					host: row.host,
				},
				value: row.value,
			})),
		},
	];
}

function serialize(
	states: PackedOriginStatusMetricState[],
	options: Parameters<typeof serializePackedOriginStatusMetrics>[1] = {},
): string {
	return [...serializePackedOriginStatusMetrics(states, options)].join("");
}

describe("serializePackedOriginStatusMetrics", () => {
	it("emits one counter sample per row across status, country and host", () => {
		const rows: Row[] = [
			{ originStatus: "200", country: "US", host: "a.example.com", value: 1 },
			{ originStatus: "502", country: "DE", host: "b.example.com", value: 2 },
			{ originStatus: "0", country: "", host: "", value: 3 },
		];

		expect(serialize([packedState(rows)])).toBe(
			`${serializeToPrometheus(unpacked(rows))}\n`,
		);
	});

	it("matches the unpacked output when the host label is excluded", () => {
		// Rows collapsing onto one label set must be summed, not emitted twice.
		const rows: Row[] = [
			{ originStatus: "200", country: "US", host: "a.example.com", value: 1 },
			{ originStatus: "200", country: "US", host: "b.example.com", value: 4 },
			{ originStatus: "502", country: "US", host: "a.example.com", value: 2 },
		];
		const options = { excludeLabels: new Set(["host"]) };

		const output = serialize([packedState(rows)], options);
		expect(output).toBe(`${serializeToPrometheus(unpacked(rows), options)}\n`);
		expect(output).toContain(
			`${METRIC_NAME}{zone="example.com",origin_status="200",country="US"} 5`,
		);
		expect(output).not.toContain("host=");
	});

	it("escapes label values and formats non-finite values", () => {
		const rows: Row[] = [
			{
				originStatus: "200",
				country: 'US"\\x',
				host: "a\nb.example.com",
				value: Number.NaN,
			},
			{
				originStatus: "502",
				country: "US",
				host: "b.example.com",
				value: Number.POSITIVE_INFINITY,
			},
		];

		expect(serialize([packedState(rows)])).toBe(
			`${serializeToPrometheus(unpacked(rows))}\n`,
		);
	});

	it("writes nothing for empty rows, empty states, or a denylisted family", () => {
		expect(serialize([])).toBe("");
		expect(serialize([packedState([])])).toBe("");
		expect(
			serialize(
				[
					packedState([
						{
							originStatus: "200",
							country: "US",
							host: "a.example.com",
							value: 1,
						},
					]),
				],
				{ denylist: new Set([METRIC_NAME]) },
			),
		).toBe("");
	});

	it("merges multiple account snapshots under one HELP block", () => {
		const output = serialize([
			packedState(
				[
					{
						originStatus: "200",
						country: "US",
						host: "a.example.com",
						value: 1,
					},
				],
				"a.example.com",
			),
			packedState(
				[
					{
						originStatus: "200",
						country: "US",
						host: "b.example.com",
						value: 2,
					},
				],
				"b.example.com",
			),
		]);

		expect(output.match(/# HELP/g)).toHaveLength(1);
		expect(output.match(/# TYPE/g)).toHaveLength(1);
		expect(output).toContain(`{zone="a.example.com"`);
		expect(output).toContain(`{zone="b.example.com"`);
	});

	it("does not serialize the whole snapshot before a reader consumes it", () => {
		const rows = Array.from({ length: 5_000 }, (_, index) => ({
			originStatus: "200",
			country: "US",
			host: `host-${index}.example.com`,
			value: 1,
		}));
		const chunks = serializePackedOriginStatusMetrics([packedState(rows)], {});

		const first = chunks.next();
		expect(first.done).toBe(false);
		expect(first.value?.length).toBeLessThan(
			[...serializePackedOriginStatusMetrics([packedState(rows)], {})].join("")
				.length,
		);
	});
});
