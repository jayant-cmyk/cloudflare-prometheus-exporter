import type { MetricDefinition, MetricType, MetricValue } from "./metrics";
import type { ColumnarMetricSource } from "./packed-columnar-metric";

export type ColumnarObservedRow = {
	labels: string[];
	value: number;
};

export type ColumnarObservedFamily = {
	name: string;
	help: string;
	type: MetricType;
	labels: string[];
	zones: Map<string, Map<string, ColumnarObservedRow>>;
};

function rowKey(labels: readonly string[]) {
	return JSON.stringify(labels);
}

class ObservationValues extends Array<MetricValue> {
	private count = 0;

	constructor(private readonly emit: (value: MetricValue) => void) {
		super();
	}

	override push(...values: MetricValue[]): number {
		for (const value of values) this.emit(value);
		this.count += values.length;
		return this.count;
	}
}

/** Collects query-handler emissions without retaining MetricValue objects. */
export class ColumnarObservationSink {
	private readonly families = new Map<string, ColumnarObservedFamily>();

	capture(metrics: readonly MetricDefinition[]) {
		for (const metric of metrics) {
			let family = this.families.get(metric.name);
			if (family === undefined) {
				family = {
					name: metric.name,
					help: metric.help,
					type: metric.type,
					labels: [],
					zones: new Map(),
				};
				this.families.set(metric.name, family);
			}
			metric.values = new ObservationValues((value) => this.add(family, value));
		}
	}

	finish(): ColumnarMetricSource[] {
		return [...this.families.values()]
			.filter((family) => family.zones.size > 0)
			.map((family) => ({
				name: family.name,
				help: family.help,
				type: family.type,
				values: {
					*[Symbol.iterator](): Iterator<MetricValue> {
						for (const [zone, rows] of family.zones) {
							for (const row of rows.values()) {
								yield {
									labels: Object.fromEntries([
										["zone", zone],
										...family.labels.map((label, index) => [
											label,
											row.labels[index] ?? "",
										]),
									]),
									value: row.value,
								};
							}
						}
					},
				},
			}));
	}

	private add(family: ColumnarObservedFamily, sample: MetricValue) {
		const discovered = Object.keys(sample.labels).filter(
			(label) => label !== "zone" && !family.labels.includes(label),
		);
		if (discovered.length > 0) {
			family.labels.push(...discovered);
			for (const rows of family.zones.values()) {
				const previous = [...rows.values()];
				rows.clear();
				for (const row of previous) {
					row.labels.push(...discovered.map(() => ""));
					rows.set(rowKey(row.labels), row);
				}
			}
		}

		const zone = sample.labels.zone ?? "";
		let rows = family.zones.get(zone);
		if (rows === undefined) {
			rows = new Map();
			family.zones.set(zone, rows);
		}
		const labels = family.labels.map((label) => sample.labels[label] ?? "");
		const key = rowKey(labels);
		const existing = rows.get(key);
		if (existing === undefined) {
			rows.set(key, { labels, value: sample.value });
		} else if (family.type === "counter") {
			existing.value += sample.value;
		} else {
			existing.value = Math.max(existing.value, sample.value);
		}
	}
}
