import { serializeColumnarMetrics } from "./packed-columnar-prometheus";
import type { ColumnarFamily } from "./packed-columnar-state";
import {
	type PackedSSLCertificateMetricState,
	packedSSLCertificateSamples,
	SSL_CERTIFICATE_KEY_LABELS,
	SSL_CERTIFICATES_METRIC_HELP,
	SSL_CERTIFICATES_METRIC_NAME,
} from "./packed-ssl-certificates-state";
import type { SerializeOptions } from "./prometheus";

const SSL_CERTIFICATE_FAMILIES: readonly ColumnarFamily[] = [
	{
		name: SSL_CERTIFICATES_METRIC_NAME,
		help: SSL_CERTIFICATES_METRIC_HELP,
		type: "gauge",
		valueIndex: 0,
	},
];

export function* serializePackedSSLCertificateMetrics(
	states: readonly PackedSSLCertificateMetricState[],
	options: SerializeOptions,
): Generator<string> {
	yield* serializeColumnarMetrics(
		packedSSLCertificateSamples(states),
		SSL_CERTIFICATE_FAMILIES,
		SSL_CERTIFICATE_KEY_LABELS,
		options,
	);
}
