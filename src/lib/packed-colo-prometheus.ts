import type { PackedColoMetricState } from "../durable-objects/MetricExporter";
import type { SerializeOptions } from "./prometheus";

// UTF-8 uses at most three bytes per UTF-16 code unit. Leave room for a line
// without constructing a second encoded copy merely to measure every buffer.
const CHUNK_TARGET_CHARS = 16 * 1024;
const COLO_METRIC_FAMILIES = [
	{
		name: "cloudflare_zone_colocation_visits_total",
		help: "Visits per colo",
		valueKey: "visits",
		missesKey: "visitsMisses",
	},
	{
		name: "cloudflare_zone_colocation_edge_response_bytes_total",
		help: "Edge response bytes per colo",
		valueKey: "edgeResponseBytes",
		missesKey: "edgeResponseBytesMisses",
	},
	{
		name: "cloudflare_zone_colocation_requests_total",
		help: "Requests per colo",
		valueKey: "requests",
		missesKey: "requestsMisses",
	},
] as const;

type ColoSample = { zone: string; colo: string; host: string; value: number };

function formatColoValue(value: number): string {
	if (Number.isNaN(value)) return "NaN";
	if (!Number.isFinite(value)) return value > 0 ? "+Inf" : "-Inf";
	return String(value);
}

function escapeColoLabel(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n");
}

function* coloSamples(
	states: readonly PackedColoMetricState[],
	metric: (typeof COLO_METRIC_FAMILIES)[number],
): Generator<ColoSample> {
	for (const state of states) {
		for (const bucket of state.zones) {
			for (const row of bucket.rows) {
				if (row[metric.missesKey] === 0) continue;
				yield {
					zone: bucket.zone,
					colo: row.colo,
					host: row.host,
					value: row[metric.valueKey],
				};
			}
		}
	}
}

function* aggregateColoHosts(
	samples: Iterable<ColoSample>,
): Generator<ColoSample> {
	const aggregated = new Map<string, ColoSample>();
	for (const sample of samples) {
		const key = `${sample.zone}\x00${sample.colo}`;
		const existing = aggregated.get(key);
		if (existing === undefined) aggregated.set(key, sample);
		else existing.value += sample.value;
	}
	yield* aggregated.values();
}

function* coloMetricLines(
	states: readonly PackedColoMetricState[],
	options: SerializeOptions,
): Generator<string> {
	const excludeHost = options.excludeLabels?.has("host") ?? false;
	for (const metric of COLO_METRIC_FAMILIES) {
		if (options.denylist?.has(metric.name)) continue;
		const samples = coloSamples(states, metric);
		let wroteHeaders = false;
		for (const sample of excludeHost ? aggregateColoHosts(samples) : samples) {
			if (!wroteHeaders) {
				yield `# HELP ${metric.name} ${metric.help}\n# TYPE ${metric.name} counter\n`;
				wroteHeaders = true;
			}
			const host = excludeHost ? "" : `,host="${escapeColoLabel(sample.host)}"`;
			yield `${metric.name}{zone="${escapeColoLabel(sample.zone)}",colo="${escapeColoLabel(sample.colo)}"${host}} ${formatColoValue(sample.value)}\n`;
		}
		if (wroteHeaders) yield "\n";
	}
}

/** Lazily serializes packed colo metrics in bounded chunks so streaming respects backpressure. */
export function* serializePackedColoMetrics(
	states: readonly PackedColoMetricState[],
	options: SerializeOptions,
): Generator<string> {
	let buffer = "";
	for (const line of coloMetricLines(states, options)) {
		buffer += line;
		if (buffer.length >= CHUNK_TARGET_CHARS) {
			yield buffer;
			buffer = "";
		}
	}
	if (buffer.length > 0) yield buffer;
}
