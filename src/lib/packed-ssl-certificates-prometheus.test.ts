import { describe, expect, it } from "vitest";
import type { MetricDefinition } from "./metrics";
import { serializePackedSSLCertificateMetrics } from "./packed-ssl-certificates-prometheus";
import type { PackedSSLCertificateMetricState } from "./packed-ssl-certificates-state";
import { serializeToPrometheus } from "./prometheus";

type Row = {
	type: string;
	issuer: string;
	status: string;
	expiresOnSeconds: number;
};

function packedState(
	rows: Row[],
	zone = "example.com",
): PackedSSLCertificateMetricState {
	return {
		format: "ssl-certificates-packed-by-zone-v1",
		accountId: "account-id",
		accountName: "Account",
		queryName: "ssl-certificates",
		lastFetch: 1,
		lastIngest: 1,
		zones: [{ zone, rows }],
	};
}

function unpacked(rows: Row[], zone = "example.com"): MetricDefinition[] {
	return [
		{
			name: "cloudflare_zone_certificate_validation_status",
			help: "Certificate expiry timestamp",
			type: "gauge",
			values: rows.map((row) => ({
				labels: {
					zone,
					type: row.type,
					issuer: row.issuer,
					status: row.status,
				},
				value: row.expiresOnSeconds,
			})),
		},
	];
}

function serialize(states: PackedSSLCertificateMetricState[]): string {
	return [...serializePackedSSLCertificateMetrics(states, {})].join("");
}

describe("serializePackedSSLCertificateMetrics", () => {
	it("matches legacy output", () => {
		const rows: Row[] = [
			{
				type: "advanced",
				issuer: "letsencrypt",
				status: "active",
				expiresOnSeconds: 1_735_689_600,
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
