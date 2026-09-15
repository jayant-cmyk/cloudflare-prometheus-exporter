import { z } from "zod";
import type { MetricDefinition } from "./metrics";
import { serializeColumnarMetrics } from "./packed-columnar-prometheus";
import {
	accumulateColumnarZones,
	type ColumnarFamily,
	type ColumnarZoneRows,
	observeColumnarWindow,
} from "./packed-columnar-state";
import type { SerializeOptions } from "./prometheus";

export const LOAD_BALANCER_METRICS_QUERY_NAME = "load-balancer-metrics";

const RequestRowSchema = z.object({
	lbName: z.string(),
	poolName: z.string(),
	originName: z.string(),
	count: z.number(),
	misses: z.number().int().nonnegative(),
	lastIngest: z.number(),
});
const PoolValueRowSchema = z.object({
	lbName: z.string(),
	poolName: z.string(),
	value: z.number(),
});
const PolicyRowSchema = z.object({ lbName: z.string(), policy: z.string() });
const PackedLoadBalancerZoneSchema = z.object({
	zone: z.string(),
	requestRows: z.array(RequestRowSchema),
	rttRows: z.array(PoolValueRowSchema),
	originsSelectedRows: z.array(PoolValueRowSchema),
	policyRows: z.array(PolicyRowSchema),
	poolHealthRows: z.array(PoolValueRowSchema),
});

export const PackedLoadBalancerMetricStateSchema = z.object({
	format: z.literal("load-balancer-packed-by-zone-v1"),
	accountId: z.string(),
	accountName: z.string(),
	queryName: z.literal(LOAD_BALANCER_METRICS_QUERY_NAME),
	lastFetch: z.number(),
	lastIngest: z.number(),
	zones: z.array(PackedLoadBalancerZoneSchema),
});

export type PackedLoadBalancerZone = z.infer<
	typeof PackedLoadBalancerZoneSchema
>;
export type PackedLoadBalancerMetricState = z.infer<
	typeof PackedLoadBalancerMetricStateSchema
>;

const REQUEST_FAMILY: ColumnarFamily = {
	name: "cloudflare_zone_pool_requests_total",
	help: "Requests per pool",
	valueIndex: 0,
};
const RTT_FAMILY: ColumnarFamily = {
	name: "cloudflare_zone_lb_pool_rtt_seconds",
	help: "Load balancer pool RTT in seconds",
	type: "gauge",
	valueIndex: 0,
};
const ORIGINS_FAMILY: ColumnarFamily = {
	name: "cloudflare_zone_lb_origins_selected_count",
	help: "Number of origins selected per load balancer request",
	type: "gauge",
	valueIndex: 0,
};
const POLICY_FAMILY: ColumnarFamily = {
	name: "cloudflare_zone_lb_steering_policy_info",
	help: "Load balancer steering policy (info metric)",
	type: "gauge",
	valueIndex: 0,
};
const HEALTH_FAMILY: ColumnarFamily = {
	name: "cloudflare_zone_pool_health_status",
	help: "Pool health (1=healthy, 0=unhealthy)",
	type: "gauge",
	valueIndex: 0,
};

function requestColumnarZones(
	zones: readonly PackedLoadBalancerZone[],
): ColumnarZoneRows[] {
	return zones.map((zone) => ({
		zone: zone.zone,
		rows: zone.requestRows.map((row) => ({
			keys: [row.lbName, row.poolName, row.originName],
			values: [row.count],
			misses: row.misses,
			lastIngest: row.lastIngest,
		})),
	}));
}

function metricValues(metrics: readonly MetricDefinition[], name: string) {
	return metrics.find((metric) => metric.name === name)?.values ?? [];
}

function poolRows(
	metrics: readonly MetricDefinition[],
	metricName: string,
	convertToMs = false,
) {
	const rows = new Map<
		string,
		{ zone: string; lbName: string; poolName: string; value: number }
	>();
	for (const sample of metricValues(metrics, metricName)) {
		const zone = sample.labels.zone ?? "";
		const lbName = sample.labels.lb_name ?? "";
		const poolName = sample.labels.pool_name ?? "";
		const key = `${zone}\x00${lbName}\x00${poolName}`;
		const value = convertToMs ? sample.value * 1000 : sample.value;
		const previous = rows.get(key)?.value ?? Number.NEGATIVE_INFINITY;
		rows.set(key, { zone, lbName, poolName, value: Math.max(previous, value) });
	}
	return rows;
}

export function accumulatePackedLoadBalancerRows(
	previous: PackedLoadBalancerMetricState | undefined,
	metrics: readonly MetricDefinition[],
	ingestId: number,
	failedScopes: ReadonlySet<string>,
): PackedLoadBalancerZone[] {
	const requests = accumulateColumnarZones(
		requestColumnarZones(previous?.zones ?? []),
		observeColumnarWindow(
			metrics,
			[REQUEST_FAMILY],
			["lb_name", "pool_name", "origin_name"],
			1,
		),
		ingestId,
		previous?.lastIngest !== ingestId,
		failedScopes,
	);
	const rtt = poolRows(metrics, RTT_FAMILY.name, true);
	const origins = poolRows(metrics, ORIGINS_FAMILY.name);
	const health = poolRows(metrics, HEALTH_FAMILY.name);
	const policies = new Map<
		string,
		{ zone: string; lbName: string; policy: string }
	>();
	for (const sample of metricValues(metrics, POLICY_FAMILY.name)) {
		const zone = sample.labels.zone ?? "";
		const lbName = sample.labels.lb_name ?? "";
		const key = `${zone}\x00${lbName}`;
		if (!policies.has(key)) {
			policies.set(key, { zone, lbName, policy: sample.labels.policy ?? "" });
		}
	}
	const requestByZone = new Map(requests.map((zone) => [zone.zone, zone.rows]));
	const zoneNames = new Set(requestByZone.keys());
	for (const row of [
		...rtt.values(),
		...origins.values(),
		...health.values(),
	]) {
		zoneNames.add(row.zone);
	}
	for (const row of policies.values()) zoneNames.add(row.zone);
	for (const zone of previous?.zones ?? []) {
		if (failedScopes.has(zone.zone)) zoneNames.add(zone.zone);
	}
	return [...zoneNames].map((zone) => {
		const old = previous?.zones.find((candidate) => candidate.zone === zone);
		if (failedScopes.has(zone) && old !== undefined) return old;
		return {
			zone,
			requestRows: (requestByZone.get(zone) ?? []).map((row) => ({
				lbName: row.keys[0] ?? "",
				poolName: row.keys[1] ?? "",
				originName: row.keys[2] ?? "",
				count: row.values[0] ?? 0,
				misses: row.misses,
				lastIngest: row.lastIngest,
			})),
			rttRows: [...rtt.values()].filter((row) => row.zone === zone),
			originsSelectedRows: [...origins.values()].filter(
				(row) => row.zone === zone,
			),
			policyRows: [...policies.values()].filter((row) => row.zone === zone),
			poolHealthRows: [...health.values()].filter((row) => row.zone === zone),
		};
	});
}

function requestSamples(states: readonly PackedLoadBalancerMetricState[]) {
	return function* samples() {
		for (const state of states)
			for (const zone of state.zones)
				for (const row of zone.requestRows)
					yield {
						zone: zone.zone,
						keys: [row.lbName, row.poolName, row.originName],
						value: row.count,
					};
	};
}

function poolSamples(
	states: readonly PackedLoadBalancerMetricState[],
	rowsFor: (zone: PackedLoadBalancerZone) => PackedLoadBalancerZone["rttRows"],
	convertFromMs = false,
) {
	return function* samples() {
		for (const state of states)
			for (const zone of state.zones)
				for (const row of rowsFor(zone))
					yield {
						zone: zone.zone,
						keys: [row.lbName, row.poolName],
						value: convertFromMs ? row.value / 1000 : row.value,
					};
	};
}

function policySamples(states: readonly PackedLoadBalancerMetricState[]) {
	return function* samples() {
		const seenPolicy = new Set<string>();
		for (const state of states) {
			for (const zone of state.zones) {
				for (const row of zone.policyRows) {
					const key = `${zone.zone}\x00${row.lbName}`;
					if (seenPolicy.has(key)) continue;
					seenPolicy.add(key);
					yield { zone: zone.zone, keys: [row.lbName, row.policy], value: 1 };
				}
			}
		}
	};
}

export function* serializePackedLoadBalancerMetrics(
	states: readonly PackedLoadBalancerMetricState[],
	options: SerializeOptions,
): Generator<string> {
	yield* serializeColumnarMetrics(
		requestSamples(states),
		[REQUEST_FAMILY],
		["lb_name", "pool_name", "origin_name"],
		options,
	);
	yield* serializeColumnarMetrics(
		poolSamples(states, (zone) => zone.rttRows, true),
		[RTT_FAMILY],
		["lb_name", "pool_name"],
		options,
	);
	yield* serializeColumnarMetrics(
		poolSamples(states, (zone) => zone.originsSelectedRows),
		[ORIGINS_FAMILY],
		["lb_name", "pool_name"],
		options,
	);
	yield* serializeColumnarMetrics(
		policySamples(states),
		[POLICY_FAMILY],
		["lb_name", "policy"],
		options,
	);
	yield* serializeColumnarMetrics(
		poolSamples(states, (zone) => zone.poolHealthRows),
		[HEALTH_FAMILY],
		["lb_name", "pool_name"],
		options,
	);
}
