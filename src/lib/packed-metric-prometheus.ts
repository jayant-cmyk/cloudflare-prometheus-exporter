import { serializePackedCacheMissMetrics } from "./packed-cache-miss-prometheus";
import {
	CACHE_MISS_METRICS_QUERY_NAME,
	type PackedCacheMissMetricState,
} from "./packed-cache-miss-state";
import { serializePackedColoErrorMetrics } from "./packed-colo-error-prometheus";
import {
	COLO_ERROR_METRICS_QUERY_NAME,
	type PackedColoErrorMetricState,
} from "./packed-colo-error-state";
import { serializePackedColoMetrics } from "./packed-colo-prometheus";
import {
	COLO_METRICS_QUERY_NAME,
	type PackedColoMetricState,
} from "./packed-colo-state";
import { serializePackedLbWeightMetrics } from "./packed-lb-weight-prometheus";
import {
	LB_WEIGHT_METRICS_QUERY_NAME,
	type PackedLbWeightMetricState,
} from "./packed-lb-weight-state";
import { serializePackedLogpushZoneMetrics } from "./packed-logpush-zone-prometheus";
import {
	LOGPUSH_ZONE_METRICS_QUERY_NAME,
	type PackedLogpushZoneMetricState,
} from "./packed-logpush-zone-state";
import type { PackedMetricState } from "./packed-metric-state";
import { serializePackedOriginStatusMetrics } from "./packed-origin-status-prometheus";
import {
	ORIGIN_STATUS_METRICS_QUERY_NAME,
	type PackedOriginStatusMetricState,
} from "./packed-origin-status-state";
import { serializePackedRequestMethodMetrics } from "./packed-request-method-prometheus";
import {
	type PackedRequestMethodMetricState,
	REQUEST_METHOD_METRICS_QUERY_NAME,
} from "./packed-request-method-state";
import { serializePackedSSLCertificateMetrics } from "./packed-ssl-certificates-prometheus";
import {
	type PackedSSLCertificateMetricState,
	SSL_CERTIFICATES_QUERY_NAME,
} from "./packed-ssl-certificates-state";
import type { SerializeOptions } from "./prometheus";

/**
 * Dispatches compact snapshots to their query-specific serializers.
 * Families are grouped per query so a scrape never splits one metric family
 * across two HELP/TYPE blocks, which Prometheus rejects.
 */
export function* serializePackedMetrics(
	states: readonly PackedMetricState[],
	options: SerializeOptions,
): Generator<string> {
	const coloStates: PackedColoMetricState[] = [];
	const cacheMissStates: PackedCacheMissMetricState[] = [];
	const coloErrorStates: PackedColoErrorMetricState[] = [];
	const lbWeightStates: PackedLbWeightMetricState[] = [];
	const logpushZoneStates: PackedLogpushZoneMetricState[] = [];
	const originStatusStates: PackedOriginStatusMetricState[] = [];
	const requestMethodStates: PackedRequestMethodMetricState[] = [];
	const sslCertificateStates: PackedSSLCertificateMetricState[] = [];
	for (const state of states) {
		switch (state.queryName) {
			case CACHE_MISS_METRICS_QUERY_NAME:
				cacheMissStates.push(state);
				break;
			case COLO_ERROR_METRICS_QUERY_NAME:
				coloErrorStates.push(state);
				break;
			case COLO_METRICS_QUERY_NAME:
				coloStates.push(state);
				break;
			case LB_WEIGHT_METRICS_QUERY_NAME:
				lbWeightStates.push(state);
				break;
			case LOGPUSH_ZONE_METRICS_QUERY_NAME:
				logpushZoneStates.push(state);
				break;
			case ORIGIN_STATUS_METRICS_QUERY_NAME:
				originStatusStates.push(state);
				break;
			case REQUEST_METHOD_METRICS_QUERY_NAME:
				requestMethodStates.push(state);
				break;
			case SSL_CERTIFICATES_QUERY_NAME:
				sslCertificateStates.push(state);
				break;
		}
	}

	yield* serializePackedCacheMissMetrics(cacheMissStates, options);
	yield* serializePackedColoErrorMetrics(coloErrorStates, options);
	yield* serializePackedColoMetrics(coloStates, options);
	yield* serializePackedLbWeightMetrics(lbWeightStates, options);
	yield* serializePackedLogpushZoneMetrics(logpushZoneStates, options);
	yield* serializePackedOriginStatusMetrics(originStatusStates, options);
	yield* serializePackedRequestMethodMetrics(requestMethodStates, options);
	yield* serializePackedSSLCertificateMetrics(sslCertificateStates, options);
}
