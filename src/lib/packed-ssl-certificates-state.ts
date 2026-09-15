import { z } from "zod";

export const SSL_CERTIFICATES_QUERY_NAME = "ssl-certificates";
export const SSL_CERTIFICATES_METRIC_NAME =
	"cloudflare_zone_certificate_validation_status";
export const SSL_CERTIFICATES_METRIC_HELP = "Certificate expiry timestamp";

const SSLCertificateRowSchema = z.object({
	type: z.string(),
	issuer: z.string(),
	status: z.string(),
	expiresOnSeconds: z.number(),
});

const PackedSSLCertificateZoneSchema = z.object({
	zone: z.string(),
	rows: z.array(SSLCertificateRowSchema),
});

export const PackedSSLCertificateMetricStateSchema = z.object({
	format: z.literal("ssl-certificates-packed-by-zone-v1"),
	accountId: z.string(),
	accountName: z.string(),
	queryName: z.literal(SSL_CERTIFICATES_QUERY_NAME),
	lastFetch: z.number(),
	lastIngest: z.number(),
	zones: z.array(PackedSSLCertificateZoneSchema),
});

export type SSLCertificateZone = z.infer<typeof PackedSSLCertificateZoneSchema>;
export type PackedSSLCertificateMetricState = z.infer<
	typeof PackedSSLCertificateMetricStateSchema
>;

export const SSL_CERTIFICATE_KEY_LABELS: readonly string[] = [
	"type",
	"issuer",
	"status",
];

/** Reads packed certificate rows lazily, one sample per stored row. */
export function packedSSLCertificateSamples(
	states: readonly PackedSSLCertificateMetricState[],
): (valueIndex: number) => Generator<{
	zone: string;
	keys: readonly string[];
	value: number;
}> {
	return function* samples() {
		for (const state of states) {
			for (const bucket of state.zones) {
				for (const row of bucket.rows) {
					yield {
						zone: bucket.zone,
						keys: [row.type, row.issuer, row.status],
						value: row.expiresOnSeconds,
					};
				}
			}
		}
	};
}
