import { z } from "zod";
import type { MetricDefinition } from "./metrics";
import {
	type ColumnarFamily,
	type ColumnarSampleSource,
	serializeColumnarMetrics,
} from "./packed-columnar-prometheus";
import type { SerializeOptions } from "./prometheus";

export const COLUMNAR_METRIC_QUERIES = [
	"adaptive-metrics",
	"cache-miss-metrics",
	"colo-error-metrics",
	"edge-country-metrics",
	"health-check-metrics",
	"hostname-http-metrics",
	"http-metrics",
	"load-balancer-metrics",
	"lb-weight-metrics",
	"logpush-zone",
	"origin-status-metrics",
	"request-method-metrics",
	"ssl-certificates",
] as const;

export type ColumnarMetricQuery = (typeof COLUMNAR_METRIC_QUERIES)[number];

const FamilyMetadataSchema = z.object({
	name: z.string(),
	help: z.string(),
	type: z.enum(["counter", "gauge"]),
});

const CounterColumnsSchema = z.object({
	misses: z.array(z.number().int().positive()),
	lastIngest: z.array(z.number()),
});

const FamilyColumnsSchema = z.object({
	family: z.number().int().nonnegative(),
	labels: z.record(z.string(), z.array(z.string())),
	values: z.array(z.number()),
	counter: CounterColumnsSchema.optional(),
});

const ZoneColumnsSchema = z.object({
	zone: z.string(),
	families: z.array(FamilyColumnsSchema),
});

export const PackedColumnarMetricStateSchema = z
	.object({
		format: z.literal("metric-columnar-v1"),
		lastIngest: z.number(),
		families: z.array(FamilyMetadataSchema),
		zones: z.array(ZoneColumnsSchema),
	})
	.superRefine((state, ctx) => {
		const familyNames = new Set<string>();
		for (const [index, family] of state.families.entries()) {
			if (familyNames.has(family.name)) {
				ctx.addIssue({
					code: "custom",
					path: ["families", index, "name"],
					message: "Duplicate metric family",
				});
			}
			familyNames.add(family.name);
		}

		const zoneNames = new Set<string>();
		for (const [zoneIndex, zone] of state.zones.entries()) {
			if (zoneNames.has(zone.zone)) {
				ctx.addIssue({
					code: "custom",
					path: ["zones", zoneIndex, "zone"],
					message: "Duplicate zone",
				});
			}
			zoneNames.add(zone.zone);
			const familyIndexes = new Set<number>();
			for (const [tableIndex, table] of zone.families.entries()) {
				const path = ["zones", zoneIndex, "families", tableIndex];
				const family = state.families[table.family];
				if (family === undefined || familyIndexes.has(table.family)) {
					ctx.addIssue({
						code: "custom",
						path: [...path, "family"],
						message: "Invalid or duplicate family index",
					});
					continue;
				}
				familyIndexes.add(table.family);
				if (
					Object.values(table.labels).some(
						(column) => column.length !== table.values.length,
					)
				) {
					ctx.addIssue({
						code: "custom",
						path: [...path, "labels"],
						message: "Packed columns must have equal lengths",
					});
				}
				const rowKeys = new Set<string>();
				const labelNames = Object.keys(table.labels);
				for (let rowIndex = 0; rowIndex < table.values.length; rowIndex++) {
					const key = rowKey(
						labelNames.map((label) => table.labels[label]?.[rowIndex] ?? ""),
					);
					if (rowKeys.has(key)) {
						ctx.addIssue({
							code: "custom",
							path: [...path, "values", rowIndex],
							message: "Duplicate label tuple",
						});
					}
					rowKeys.add(key);
				}
				if (
					family.type === "counter" &&
					(table.counter === undefined ||
						table.counter.misses.length !== table.values.length ||
						table.counter.lastIngest.length !== table.values.length)
				) {
					ctx.addIssue({
						code: "custom",
						path: [...path, "counter"],
						message: "Counter columns must match values",
					});
				}
				if (family.type === "gauge" && table.counter !== undefined) {
					ctx.addIssue({
						code: "custom",
						path: [...path, "counter"],
						message: "Gauge families cannot have counter columns",
					});
				}
			}
		}
	});

export type PackedColumnarMetricState = z.infer<
	typeof PackedColumnarMetricStateSchema
>;
type FamilyMetadata = PackedColumnarMetricState["families"][number];

type Row = {
	labels: string[];
	value: number;
	misses?: number;
	lastIngest?: number;
};

const STALE_MISSES = 5;

export function isColumnarMetricQuery(
	query: string,
): query is ColumnarMetricQuery {
	return COLUMNAR_METRIC_QUERIES.some((candidate) => candidate === query);
}

function rowKey(labels: readonly string[]) {
	return JSON.stringify(labels);
}

function metricLabels(metric: MetricDefinition): string[] {
	const labels = new Set<string>();
	for (const sample of metric.values) {
		for (const label of Object.keys(sample.labels)) {
			if (label !== "zone") labels.add(label);
		}
	}
	return [...labels];
}

function collectFamilies(
	previous: PackedColumnarMetricState | undefined,
	metrics: readonly MetricDefinition[],
): FamilyMetadata[] {
	const families = previous?.families.map((family) => ({ ...family })) ?? [];
	const indexes = new Map(
		families.map((family, index) => [family.name, index]),
	);
	for (const metric of metrics) {
		const current = {
			name: metric.name,
			help: metric.help,
			type: metric.type,
		};
		const index = indexes.get(metric.name);
		if (index === undefined) {
			indexes.set(metric.name, families.length);
			families.push(current);
		} else {
			families[index] = current;
		}
	}
	return families;
}

function collectFamilyLabels(
	previous: PackedColumnarMetricState | undefined,
	metrics: readonly MetricDefinition[],
	families: readonly FamilyMetadata[],
): Map<number, string[]> {
	const labelsByFamily = new Map<number, string[]>();
	const append = (family: number, labels: readonly string[]) => {
		const current = labelsByFamily.get(family) ?? [];
		current.push(...labels.filter((label) => !current.includes(label)));
		labelsByFamily.set(family, current);
	};
	for (const zone of previous?.zones ?? []) {
		for (const table of zone.families) {
			append(table.family, Object.keys(table.labels));
		}
	}
	const familyIndexes = new Map(
		families.map((family, index) => [family.name, index]),
	);
	for (const metric of metrics) {
		const family = familyIndexes.get(metric.name);
		if (family !== undefined) append(family, metricLabels(metric));
	}
	return labelsByFamily;
}

function storedRows(
	table: z.infer<typeof FamilyColumnsSchema> | undefined,
	labels: readonly string[],
): Map<string, Row> {
	const rows = new Map<string, Row>();
	if (table === undefined) return rows;
	for (let index = 0; index < table.values.length; index++) {
		const values = labels.map((label) => table.labels[label]?.[index] ?? "");
		rows.set(rowKey(values), {
			labels: values,
			value: table.values[index] ?? 0,
			misses: table.counter?.misses[index],
			lastIngest: table.counter?.lastIngest[index],
		});
	}
	return rows;
}

function observedRowsByZone(
	metrics: readonly MetricDefinition[],
	families: readonly FamilyMetadata[],
	labelsByFamily: ReadonlyMap<number, readonly string[]>,
): Map<string, Map<number, Map<string, Row>>> {
	const familyIndexes = new Map(
		families.map((family, index) => [family.name, index]),
	);
	const zones = new Map<string, Map<number, Map<string, Row>>>();
	for (const metric of metrics) {
		const familyIndex = familyIndexes.get(metric.name);
		const family =
			familyIndex === undefined ? undefined : families[familyIndex];
		if (familyIndex === undefined || family === undefined) continue;
		for (const sample of metric.values) {
			const zone = sample.labels.zone ?? "";
			let tables = zones.get(zone);
			if (tables === undefined) {
				tables = new Map();
				zones.set(zone, tables);
			}
			let rows = tables.get(familyIndex);
			if (rows === undefined) {
				rows = new Map();
				tables.set(familyIndex, rows);
			}
			const labels = (labelsByFamily.get(familyIndex) ?? []).map(
				(label) => sample.labels[label] ?? "",
			);
			const key = rowKey(labels);
			const old = rows.get(key);
			if (old === undefined) {
				rows.set(key, { labels, value: sample.value });
			} else if (family.type === "counter") {
				old.value += sample.value;
			} else {
				old.value = Math.max(old.value, sample.value);
			}
		}
	}
	return zones;
}

function mergeCounterRows(
	previous: Map<string, Row>,
	observed: Map<string, Row>,
	ingestId: number,
	ageMissing: boolean,
) {
	const rows = new Map<string, Row>();
	for (const [key, old] of previous) {
		const current = observed.get(key);
		if (current !== undefined) {
			observed.delete(key);
			rows.set(key, {
				labels: old.labels,
				value: old.value + (old.lastIngest === ingestId ? 0 : current.value),
				misses: STALE_MISSES,
				lastIngest: ingestId,
			});
		} else if (!ageMissing || (old.misses ?? STALE_MISSES) > 1) {
			rows.set(key, {
				...old,
				misses: ageMissing ? (old.misses ?? STALE_MISSES) - 1 : old.misses,
			});
		}
	}
	for (const [key, row] of observed) {
		rows.set(key, {
			...row,
			misses: STALE_MISSES,
			lastIngest: ingestId,
		});
	}
	return rows;
}

function packRows(
	familyIndex: number,
	family: FamilyMetadata,
	labelNames: readonly string[],
	rows: Iterable<Row>,
) {
	const labels: Record<string, string[]> = Object.fromEntries(
		labelNames.map((label) => [label, []]),
	);
	const values: number[] = [];
	const misses: number[] = [];
	const lastIngest: number[] = [];
	for (const row of rows) {
		values.push(row.value);
		for (const [index, label] of labelNames.entries()) {
			labels[label]?.push(row.labels[index] ?? "");
		}
		if (family.type === "counter") {
			misses.push(row.misses ?? STALE_MISSES);
			lastIngest.push(row.lastIngest ?? 0);
		}
	}
	if (values.length === 0) return undefined;
	return {
		family: familyIndex,
		labels,
		values,
		...(family.type === "counter" ? { counter: { misses, lastIngest } } : {}),
	};
}

export function accumulateColumnarMetricState(input: {
	previous: PackedColumnarMetricState | undefined;
	metrics: readonly MetricDefinition[];
	ingestId: number;
	failedScopes: ReadonlySet<string>;
}): PackedColumnarMetricState {
	const previous = input.previous;
	const families = collectFamilies(previous, input.metrics);
	const labelsByFamily = collectFamilyLabels(previous, input.metrics, families);
	const previousZones = new Map(
		(previous?.zones ?? []).map((zone) => [zone.zone, zone]),
	);
	const observedZones = observedRowsByZone(
		input.metrics,
		families,
		labelsByFamily,
	);
	const zoneNames = new Set(previousZones.keys());
	for (const zone of observedZones.keys()) zoneNames.add(zone);
	const ageMissing = previous?.lastIngest !== input.ingestId;
	const zones: PackedColumnarMetricState["zones"] = [];
	for (const zone of zoneNames) {
		const previousZone = previousZones.get(zone);
		if (input.failedScopes.has(zone) && previousZone !== undefined) {
			zones.push(previousZone);
			continue;
		}
		const tables = families.flatMap((family, familyIndex) => {
			const labels = labelsByFamily.get(familyIndex) ?? [];
			const observed =
				observedZones.get(zone)?.get(familyIndex) ?? new Map<string, Row>();
			const rows =
				family.type === "counter"
					? mergeCounterRows(
							storedRows(
								previousZone?.families.find(
									(table) => table.family === familyIndex,
								),
								labels,
							),
							observed,
							input.ingestId,
							ageMissing,
						)
					: observed;
			const packed = packRows(familyIndex, family, labels, rows.values());
			return packed === undefined ? [] : [packed];
		});
		if (tables.length > 0) zones.push({ zone, families: tables });
	}
	return {
		format: "metric-columnar-v1",
		lastIngest: input.ingestId,
		families,
		zones,
	};
}

function familySamples(
	states: readonly PackedColumnarMetricState[],
	metricName: string,
	labels: readonly string[],
): ColumnarSampleSource {
	return function* samples() {
		for (const state of states) {
			const familyIndex = state.families.findIndex(
				(family) => family.name === metricName,
			);
			if (familyIndex < 0) continue;
			for (const zone of state.zones) {
				const table = zone.families.find(
					(candidate) => candidate.family === familyIndex,
				);
				if (table === undefined) continue;
				for (let index = 0; index < table.values.length; index++) {
					yield {
						zone: zone.zone,
						keys: labels.map((label) => table.labels[label]?.[index] ?? ""),
						value: table.values[index] ?? 0,
					};
				}
			}
		}
	};
}

export function* serializeColumnarMetricStates(
	states: readonly PackedColumnarMetricState[],
	options: SerializeOptions,
): Generator<string> {
	const families = new Map<string, FamilyMetadata>();
	const labelsByFamily = new Map<string, string[]>();
	for (const state of states) {
		for (const family of state.families) {
			if (!families.has(family.name)) families.set(family.name, family);
		}
		for (const zone of state.zones) {
			for (const table of zone.families) {
				const name = state.families[table.family]?.name;
				if (name === undefined) continue;
				const labels = labelsByFamily.get(name) ?? [];
				labels.push(
					...Object.keys(table.labels).filter(
						(label) => !labels.includes(label),
					),
				);
				labelsByFamily.set(name, labels);
			}
		}
	}
	for (const family of families.values()) {
		const labels = labelsByFamily.get(family.name) ?? [];
		const outputFamily: ColumnarFamily = family;
		yield* serializeColumnarMetrics(
			familySamples(states, family.name, labels),
			outputFamily,
			labels,
			options,
		);
	}
}
