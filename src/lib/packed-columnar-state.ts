import type { MetricDefinition, MetricType } from "./metrics";

/** Consecutive windows a row may be absent before it is dropped. */
export const STALE_COUNTER_MISSES = 5;

/**
 * One accumulated row in neutral form: positional key labels, positional
 * counter values, and the aging checkpoints shared by every value column.
 *
 * Every value column of a row comes from the same GraphQL group, so one
 * `misses`/`lastIngest` pair per row is sufficient.
 */
export type ColumnarRow = {
	keys: string[];
	values: number[];
	misses: number;
	lastIngest: number;
};

/** Rows grouped by the zone label they were observed under. */
export type ColumnarZoneRows = {
	zone: string;
	rows: ColumnarRow[];
};

/** Binds one exported Prometheus family to the value slot it accumulates. */
export type ColumnarFamily = {
	name: string;
	help: string;
	type?: MetricType;
	valueIndex: number;
};

function rowKey(keys: readonly string[]): string {
	return keys.join("\x00");
}

/**
 * Reverse-maps a fetched query window into neutral rows.
 * Metrics not belonging to a known family are ignored, and values sharing a
 * key tuple are summed so duplicate GraphQL groups collapse into one row.
 *
 * @param metrics Metrics returned for the current query window.
 * @param families Exported families and the value slot each one feeds.
 * @param keyLabels Label names forming the row key, in export order.
 * @param valueCount Number of value slots per row.
 * @returns Observed rows grouped by zone, in observation order.
 */
export function observeColumnarWindow(
	metrics: readonly MetricDefinition[],
	families: readonly ColumnarFamily[],
	keyLabels: readonly string[],
	valueCount: number,
): ColumnarZoneRows[] {
	const zones = new Map<string, Map<string, ColumnarRow>>();
	for (const metric of metrics) {
		const family = families.find((candidate) => candidate.name === metric.name);
		if (family === undefined) continue;
		for (const { labels, value } of metric.values) {
			const zone = labels.zone ?? "";
			let rows = zones.get(zone);
			if (rows === undefined) {
				rows = new Map();
				zones.set(zone, rows);
			}
			const keys = keyLabels.map((label) => labels[label] ?? "");
			const key = rowKey(keys);
			const row = rows.get(key) ?? {
				keys,
				values: Array.from({ length: valueCount }, () => 0),
				misses: STALE_COUNTER_MISSES,
				lastIngest: 0,
			};
			row.values[family.valueIndex] =
				(row.values[family.valueIndex] ?? 0) + value;
			rows.set(key, row);
		}
	}
	return [...zones].map(([zone, rows]) => ({ zone, rows: [...rows.values()] }));
}

/**
 * Merges one observed window into previously accumulated rows.
 *
 * Replaying the same `ingestId` is idempotent, so a retried refresh cannot
 * double-count. Rows absent for `STALE_COUNTER_MISSES` consecutive windows are
 * dropped, while rows whose zone is in `failedScopes` are neither aged nor
 * dropped because their absence is not authoritative.
 *
 * @param previous Rows accumulated by earlier windows.
 * @param observed Rows observed in the current window.
 * @param ingestId Stable identifier of the current query window.
 * @param ageMissing False when replaying a window already ingested.
 * @param failedScopes Zone labels whose query failed this refresh.
 * @returns Accumulated rows grouped by zone, excluding emptied zones.
 */
export function accumulateColumnarZones(
	previous: readonly ColumnarZoneRows[],
	observed: readonly ColumnarZoneRows[],
	ingestId: number,
	ageMissing: boolean,
	failedScopes: ReadonlySet<string>,
): ColumnarZoneRows[] {
	const pending = new Map<string, Map<string, ColumnarRow>>();
	for (const bucket of observed) {
		pending.set(
			bucket.zone,
			new Map(bucket.rows.map((row) => [rowKey(row.keys), row])),
		);
	}

	const next = new Map<string, ColumnarRow[]>();
	const rowsFor = (zone: string): ColumnarRow[] => {
		const existing = next.get(zone);
		if (existing !== undefined) return existing;
		const created: ColumnarRow[] = [];
		next.set(zone, created);
		return created;
	};

	for (const bucket of previous) {
		const target = rowsFor(bucket.zone);
		const observedRows = pending.get(bucket.zone);
		for (const stored of bucket.rows) {
			const key = rowKey(stored.keys);
			const seen = observedRows?.get(key);
			if (seen !== undefined) {
				observedRows?.delete(key);
				// Retries can replay the same Cloudflare window; only add it once.
				const skip = stored.lastIngest === ingestId;
				target.push({
					keys: stored.keys,
					values: stored.values.map(
						(value, index) => value + (skip ? 0 : (seen.values[index] ?? 0)),
					),
					misses: STALE_COUNTER_MISSES,
					lastIngest: ingestId,
				});
			} else if (!ageMissing || failedScopes.has(bucket.zone)) {
				// Absent counters keep their checkpoint so a retried window can
				// still ingest them later.
				target.push(stored);
			} else if (stored.misses > 1) {
				target.push({ ...stored, misses: stored.misses - 1 });
			}
		}
	}

	for (const [zone, rows] of pending) {
		for (const row of rows.values()) {
			rowsFor(zone).push({
				...row,
				misses: STALE_COUNTER_MISSES,
				lastIngest: ingestId,
			});
		}
	}

	return [...next]
		.map(([zone, rows]) => ({ zone, rows }))
		.filter((bucket) => bucket.rows.length > 0);
}
