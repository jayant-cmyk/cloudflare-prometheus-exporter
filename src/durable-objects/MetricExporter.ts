import { DurableObject } from "cloudflare:workers";
import z from "zod";
import {
	getCloudflareMetricsClient,
	isAccountLevelQuery,
	isZoneLevelQuery,
} from "../cloudflare/client";
import { isPaidTierGraphQLQuery } from "../cloudflare/queries";
import { runAlarmWithRecovery } from "../lib/alarm-recovery";
import {
	chunkedDurableObjectStorage,
	loadChunkedValue,
	saveChunkedValue,
} from "../lib/chunked-storage";
import { accumulateCounterMetrics } from "../lib/counters";
import { parseCommaSeparated, partitionZonesByTier } from "../lib/filters";
import { configFromEnv, createLogger, type Logger } from "../lib/logger";
import { getMetricRefreshDelaySeconds } from "../lib/metric-refresh";
import {
	type MetricDefinition,
	MetricDefinitionSchema,
	type MetricValue,
	mergeMetricDefinitions,
} from "../lib/metrics";
import { getConfig, type ResolvedConfig } from "../lib/runtime-config";
import { getTimeRange } from "../lib/time";
import {
	CounterStateSchema,
	MetricExporterIdSchema,
	type MetricExporterIdString,
	type TimeRange,
	type Zone,
	ZoneSchema,
} from "../lib/types";

const STATE_KEY = "state";
const STATE_METRIC_SHARDS_KEY = "metric-shards";
const ALARM_RECOVERY_DELAY_MS = 60 * 1000;
const COLO_METRICS_QUERY_NAME = "colo-metrics";
const STORAGE_BUCKET_SECONDS = 5;
const STORAGE_BUCKET_ROTATION_MINUTES = 3;

const StorageBucketPayloadSchema = z.object({
	timestamp: z.string(),
	metrics: z.array(MetricDefinitionSchema),
});

const MetricShardMetadataSchema = z.object({
	name: z.string(),
	help: z.string(),
	type: z.enum(["counter", "gauge"]),
	shardKeyLabel: z.string(),
	shardCount: z.number().int().positive(),
});

const MetricShardPayloadSchema = z.object({
	metrics: z.array(MetricDefinitionSchema),
});

const ShardedMetricManifestSchema = z.object({
	metrics: z.array(MetricDefinitionSchema),
	shardedMetrics: z.array(MetricShardMetadataSchema),
});

const ShardedStorageBucketManifestSchema = z.object({
	timestamp: z.string(),
	metrics: z.array(MetricDefinitionSchema),
	shardedMetrics: z.array(MetricShardMetadataSchema),
});

type MetricShardRule = ResolvedConfig["metricShards"][number];
type MetricShardMetadata = z.infer<typeof MetricShardMetadataSchema>;

/**
 * Maximum allowed hostnames in HOST_METRICS_ALLOWLIST.
 * Limits GraphQL variable size and prevents cardinality explosion.
 */
const MAX_HOSTNAME_ALLOWLIST_SIZE = 50;

const MetricExporterStateSchema = z.object({
	// Core identity
	scopeType: z.enum(["account", "zone"]),
	scopeId: z.string(),
	queryName: z.string(),

	// Metric storage
	counters: z.record(z.string(), CounterStateSchema),
	metrics: z.array(MetricDefinitionSchema),
	metricShardsEnabled: z.boolean().default(false),
	lastIngest: z.number(),

	// Context for fetching (account-scoped)
	accountId: z.string(),
	accountName: z.string(),
	zones: z.array(ZoneSchema),
	firewallRules: z.record(z.string(), z.string()),

	// Context for fetching (zone-scoped)
	zoneMetadata: ZoneSchema.nullable(),

	// Refresh state
	refreshInterval: z.number(),
	lastRefresh: z.number(),
	lastError: z.string().nullable(),
	zoneRetryAfter: z.record(z.string(), z.number()).default({}),

	// SSL cert cache (zone-scoped only)
	lastSslFetch: z.number(),
});

type MetricExporterState = z.infer<typeof MetricExporterStateSchema>;

type MetricFetchResult = {
	metrics: MetricDefinition[];
	partialErrors: unknown[];
	failedScopes: ReadonlySet<string>;
	zoneRetryAfter: Record<string, number>;
};

function storageBucketKey(
	queryName: string,
	accountId: string,
	bucketStart: Date,
	suffix = "",
): string {
	const minuteSlot =
		bucketStart.getUTCMinutes() % STORAGE_BUCKET_ROTATION_MINUTES;
	const seconds =
		Math.floor(bucketStart.getUTCSeconds() / STORAGE_BUCKET_SECONDS) *
		STORAGE_BUCKET_SECONDS;
	return `${queryName}_${accountId}_${minuteSlot}_min_${seconds}${suffix}`;
}

function fixedMinuteRange(config: ResolvedConfig): TimeRange {
	return getTimeRange(config.scrapeDelaySeconds, 60);
}

function currentStorageBucketStart(config: ResolvedConfig): Date {
	const currentSeconds =
		Math.floor(new Date().getUTCSeconds() / STORAGE_BUCKET_SECONDS) *
		STORAGE_BUCKET_SECONDS;
	const minuteStart = new Date(fixedMinuteRange(config).mintime);
	minuteStart.setUTCSeconds(currentSeconds, 0);
	return minuteStart;
}

function storageBucketRanges(timeRange: TimeRange): TimeRange[] {
	const startMs = new Date(timeRange.mintime).getTime();
	const endMs = new Date(timeRange.maxtime).getTime();
	const bucketMs = STORAGE_BUCKET_SECONDS * 1000;
	const ranges: TimeRange[] = [];

	for (let start = startMs; start < endMs; start += bucketMs) {
		ranges.push({
			mintime: new Date(start).toISOString(),
			maxtime: new Date(Math.min(start + bucketMs, endMs)).toISOString(),
		});
	}

	return ranges;
}

function metricShardRulesForQuery(
	config: ResolvedConfig,
	queryName: string,
): MetricShardRule[] {
	return config.metricShards.filter((rule) => rule.queryName === queryName);
}

function metricShardRuleForMetric(
	rules: MetricShardRule[],
	metricName: string,
): MetricShardRule | undefined {
	return rules.find(
		(rule) =>
			rule.metricNames === undefined || rule.metricNames.includes(metricName),
	);
}

function shardIndex(value: string, shardCount: number): number {
	let hash = 0;
	for (let i = 0; i < value.length; i++) {
		hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
	}
	return hash % shardCount;
}

function splitMetricsForSharding(
	metrics: MetricDefinition[],
	rules: MetricShardRule[],
): {
	unshardedMetrics: MetricDefinition[];
	shardMetrics: Map<number, MetricDefinition[]>;
	shardedMetrics: MetricShardMetadata[];
} {
	const unshardedMetrics: MetricDefinition[] = [];
	const shardMetrics = new Map<number, MetricDefinition[]>();
	const shardedMetrics: MetricShardMetadata[] = [];

	// Database-style sharding: metric family ~= table, label ~= shard key
	// column, hash(label value) % shardCount ~= physical shard selection.
	for (const metric of metrics) {
		const rule = metricShardRuleForMetric(rules, metric.name);
		if (rule === undefined) {
			unshardedMetrics.push(metric);
			continue;
		}

		const unshardedValues: MetricValue[] = [];
		const valuesByShard = new Map<number, MetricValue[]>();
		for (const value of metric.values) {
			const labelValue = value.labels[rule.shardKeyLabel];
			if (labelValue === undefined) {
				unshardedValues.push(value);
				continue;
			}
			const index = shardIndex(labelValue, rule.shardCount);
			const values = valuesByShard.get(index) ?? [];
			values.push(value);
			valuesByShard.set(index, values);
		}

		if (unshardedValues.length > 0) {
			unshardedMetrics.push({ ...metric, values: unshardedValues });
		}

		for (let index = 0; index < rule.shardCount; index++) {
			const values = valuesByShard.get(index) ?? [];
			if (values.length === 0) continue;
			const metricsForShard = shardMetrics.get(index) ?? [];
			metricsForShard.push({ ...metric, values });
			shardMetrics.set(index, metricsForShard);
		}

		shardedMetrics.push({
			name: metric.name,
			help: metric.help,
			type: metric.type,
			shardKeyLabel: rule.shardKeyLabel,
			shardCount: rule.shardCount,
		});
	}

	return { unshardedMetrics, shardMetrics, shardedMetrics };
}

/**
 * Durable Object that fetches and exports Prometheus metrics for a specific query scope.
 * Handles counter accumulation, alarm-based refresh scheduling, and metric caching.
 */
export class MetricExporter extends DurableObject<Env> {
	private state: MetricExporterState | undefined;
	private stateLoadFailed = false;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			try {
				await this.loadState();
			} catch {
				// Keep the object alive so alarm() can schedule indefinite recovery.
				this.stateLoadFailed = true;
			}
		});
	}

	/** Load and validate state from Durable Object storage. */
	private async loadState(): Promise<void> {
		this.state = await loadChunkedValue(
			chunkedDurableObjectStorage(this.ctx.storage),
			STATE_KEY,
			MetricExporterStateSchema,
		);
		this.stateLoadFailed = false;
	}

	/** Retry constructor load failures from inside the protected alarm path. */
	private async retryFailedStateLoad(): Promise<void> {
		if (!this.stateLoadFailed) return;
		await this.loadState();
	}

	/**
	 * Create a logger instance with context from the exporter's state.
	 *
	 * @param config Resolved runtime configuration.
	 * @returns Logger instance with scope type, scope ID, and query name context.
	 */
	private createLogger(config: ResolvedConfig): Logger {
		const state = this.getState();
		return createLogger("metric_exporter", {
			format: config.logFormat,
			level: config.logLevel,
		})
			.child(state.scopeType)
			.child(state.scopeId)
			.child(state.queryName);
	}

	/**
	 * Get the current state or throw if not initialized.
	 *
	 * @returns Current state.
	 * @throws {Error} When state is undefined.
	 */
	private getState(): MetricExporterState {
		if (this.state === undefined) {
			console.error(
				"State not initialized - initialize() must be called first",
			);
			throw new Error("State not initialized");
		}
		return this.state;
	}

	/**
	 * Get or create a MetricExporter instance by ID, ensuring it's initialized.
	 *
	 * @param id Composite ID in format "scopeType:scopeId:queryName".
	 * @param env Worker environment bindings.
	 * @returns Initialized MetricExporter stub.
	 */
	static async get(id: MetricExporterIdString, env: Env) {
		const stub = env.MetricExporter.getByName(id);
		await stub.initialize(id);
		return stub;
	}

	/**
	 * Initialize the exporter state from a composite ID.
	 * Idempotent - skips if already initialized.
	 *
	 * @param id Composite ID string to parse into scope type, scope ID, and query name.
	 * @throws {ZodError} When ID format is invalid.
	 */
	async initialize(id: string): Promise<void> {
		if (this.state !== undefined) {
			return;
		}
		if (this.stateLoadFailed) {
			await this.loadState();
			if (this.state !== undefined) return;
		}

		const config = await getConfig(this.env);
		const parsed = MetricExporterIdSchema.parse(id);

		const initializedState: MetricExporterState = {
			scopeType: parsed.scopeType,
			scopeId: parsed.scopeId,
			queryName: parsed.queryName,
			counters: {},
			metrics: [],
			metricShardsEnabled: false,
			lastIngest: 0,
			accountId: "",
			accountName: "",
			zones: [],
			firewallRules: {},
			zoneMetadata: null,
			refreshInterval: config.metricRefreshIntervalSeconds,
			lastRefresh: 0,
			lastError: null,
			zoneRetryAfter: {},
			lastSslFetch: 0,
		};

		await this.saveState(initializedState);
		this.state = initializedState;
	}

	/**
	 * Update zone context for account-scoped exporters.
	 * Called by AccountMetricCoordinator after zone list refresh.
	 * Triggers immediate fetch on first context push.
	 *
	 * @param accountId Cloudflare account ID.
	 * @param accountName Account display name.
	 * @param zones List of zones in the account.
	 * @param firewallRules Map of firewall rule IDs to descriptions.
	 * @param timeRange Shared time range for metrics queries.
	 */
	async updateZoneContext(
		accountId: string,
		accountName: string,
		zones: Zone[],
		firewallRules: Record<string, string>,
		timeRange: TimeRange,
	): Promise<void> {
		const config = await getConfig(this.env);
		const logger = this.createLogger(config);
		const state = this.getState();

		if (state.scopeType !== "account") {
			logger.warn("updateZoneContext called on non-account exporter");
			return;
		}

		const isFirstContext =
			state.zones.length === 0 && zones.length > 0 && state.lastRefresh === 0;

		const updatedState: MetricExporterState = {
			...state,
			accountId,
			accountName,
			zones,
			firewallRules,
		};
		await this.saveState(updatedState);
		this.state = updatedState;

		logger.info("Zone context updated", { zone_count: zones.length });

		// On first context push, fetch immediately then schedule recurring alarm
		if (isFirstContext) {
			await this.refreshWithTimeRange(timeRange, config, logger);
		}
	}

	/**
	 * Initialize zone-scoped exporter with zone metadata.
	 * Called by AccountMetricCoordinator when ensuring zone exporters exist.
	 * Triggers immediate fetch on first initialization.
	 *
	 * @param zone Zone metadata including ID, name, and plan.
	 * @param accountId Cloudflare account ID that owns the zone.
	 * @param accountName Account display name.
	 * @param timeRange Shared time range for metrics queries.
	 */
	async initializeZone(
		zone: Zone,
		accountId: string,
		accountName: string,
		timeRange: TimeRange,
	): Promise<void> {
		const config = await getConfig(this.env);
		const logger = this.createLogger(config);
		const state = this.getState();

		if (state.scopeType !== "zone") {
			logger.warn("initializeZone called on non-zone exporter");
			return;
		}

		const isFirstInit = state.zoneMetadata === null && state.lastRefresh === 0;

		const updatedState: MetricExporterState = {
			...state,
			accountId,
			accountName,
			zoneMetadata: zone,
		};
		await this.saveState(updatedState);
		this.state = updatedState;

		logger.info("Zone metadata set", { zone: zone.name });

		// On first init, fetch immediately then schedule recurring alarm
		if (isFirstInit) {
			await this.refreshWithTimeRange(timeRange, config, logger);
		}
	}

	/**
	 * Durable Object alarm handler.
	 * Triggers metric refresh and reschedules next alarm with jitter.
	 */
	override async alarm(): Promise<void> {
		let logger: Logger | undefined;

		await runAlarmWithRecovery({
			run: async () => {
				logger = createLogger("metric_exporter_alarm", configFromEnv(this.env));
				await this.retryFailedStateLoad();
				const config = await getConfig(this.env);
				logger = this.createLogger(config);
				logger.info("Alarm fired, refreshing");
				const timeRange = getTimeRange(
					config.scrapeDelaySeconds,
					config.timeWindowSeconds,
				);
				await this.refreshWithTimeRange(timeRange, config, logger);
			},
			getLogger: () => logger,
			scheduleRecoveryAlarm: () =>
				this.ctx.storage.setAlarm(Date.now() + ALARM_RECOVERY_DELAY_MS),
		});
	}

	/**
	 * Public method for coordinator to trigger refresh with shared time range.
	 * Called by AccountMetricCoordinator to ensure all exporters use the same time window.
	 *
	 * @param timeRange Shared time range calculated by coordinator.
	 */
	async triggerRefresh(timeRange: TimeRange): Promise<void> {
		const config = await getConfig(this.env);
		const logger = this.createLogger(config);
		await this.refreshWithTimeRange(timeRange, config, logger);
	}

	/**
	 * Refresh metrics from Cloudflare API using the provided time range.
	 * Handles account-scoped and zone-scoped queries, processes counters, and schedules next alarm.
	 *
	 * @param timeRange Time range for metrics queries.
	 * @param config Resolved runtime configuration.
	 * @param logger Logger instance for logging.
	 */
	private async refreshWithTimeRange(
		timeRange: TimeRange,
		config: ResolvedConfig,
		logger: Logger,
	): Promise<void> {
		const state = this.getState();

		// Skip if zone context not yet pushed (account-scoped needs zones)
		if (state.scopeType === "account" && state.zones.length === 0) {
			logger.info("Skipping refresh - no zone context yet");
			await this.scheduleNextAlarm(config);
			return;
		}

		// Skip if zone metadata not set (zone-scoped)
		if (state.scopeType === "zone" && state.zoneMetadata === null) {
			logger.info("Skipping refresh - no zone metadata yet");
			await this.scheduleNextAlarm(config);
			return;
		}

		// For zone-scoped (SSL certs), check cache TTL
		if (state.scopeType === "zone") {
			const cacheAgeMs = Date.now() - state.lastSslFetch;
			const cacheTtlMs = config.sslCertsCacheTtlSeconds * 1000;
			if (state.lastSslFetch > 0 && cacheAgeMs < cacheTtlMs) {
				logger.debug("SSL cert cache fresh, skipping fetch", {
					age_seconds: Math.floor(cacheAgeMs / 1000),
					ttl_seconds: config.sslCertsCacheTtlSeconds,
				});
				await this.scheduleNextAlarm(config);
				return;
			}
		}

		const client = getCloudflareMetricsClient(this.env);
		let nextRefreshDelaySeconds = config.metricRefreshIntervalSeconds;

		try {
			let result: MetricFetchResult;

			if (state.scopeType === "account") {
				result = await this.fetchAccountScopedMetrics(
					client,
					state,
					timeRange,
					config,
					logger,
				);
			} else {
				result = {
					metrics: await this.fetchZoneScopedMetrics(client, state),
					partialErrors: [],
					failedScopes: new Set(),
					zoneRetryAfter: {},
				};
			}

			const ingestId = new Date(timeRange.maxtime).getTime();
			const processed = accumulateCounterMetrics(
				result.metrics,
				state.counters,
				{
					ingestId,
					ageMissingCounters: state.lastIngest !== ingestId,
					failedScopes: result.failedScopes,
				},
			);
			const currentState = this.getState();
			const shardRules = metricShardRulesForQuery(
				config,
				currentState.queryName,
			);
			const metricStorage = await this.saveStateMetricShards(
				processed.metrics,
				shardRules,
			);
			const refreshedState: MetricExporterState = {
				...currentState,
				metrics: metricStorage.metrics,
				metricShardsEnabled: metricStorage.enabled,
				counters: processed.counters,
				lastIngest: ingestId,
				lastRefresh: Date.now(),
				lastSslFetch:
					state.scopeType === "zone" ? Date.now() : currentState.lastSslFetch,
				lastError: null,
				zoneRetryAfter: result.zoneRetryAfter,
			};
			await this.saveState(refreshedState);
			this.state = refreshedState;

			logger.info("Refresh complete", {
				metric_count: result.metrics.length,
				partial_failure_count: result.partialErrors.length,
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			nextRefreshDelaySeconds = getMetricRefreshDelaySeconds(
				error,
				config.metricRefreshIntervalSeconds,
			);
			logger.error("Refresh failed", {
				error: msg,
				retry_seconds: nextRefreshDelaySeconds,
			});
			const errorState: MetricExporterState = {
				...this.getState(),
				lastError: msg,
			};
			await this.saveState(errorState);
			this.state = errorState;
		}

		await this.scheduleNextAlarm(config, nextRefreshDelaySeconds);
	}

	/**
	 * Schedule the next alarm with jitter for time range alignment.
	 *
	 * @param config Resolved runtime configuration.
	 */
	private async scheduleNextAlarm(
		config: ResolvedConfig,
		delaySeconds: number = config.metricRefreshIntervalSeconds,
	): Promise<void> {
		const intervalMs = config.metricRefreshIntervalSeconds * 1000;
		const delayMs = delaySeconds * 1000;
		const now = Date.now();
		const jitter = 1000 + Math.random() * 4000;
		const nextAlarm =
			delaySeconds === config.metricRefreshIntervalSeconds
				? Math.floor(now / intervalMs) * intervalMs + intervalMs + jitter
				: now + delayMs + jitter;

		await this.ctx.storage.setAlarm(nextAlarm);
	}

	private async saveStorageBucket(
		key: string,
		bucketStart: string,
		metrics: MetricDefinition[],
		rules: MetricShardRule[],
	): Promise<void> {
		if (rules.length === 0) {
			await saveChunkedValue(
				chunkedDurableObjectStorage(this.ctx.storage),
				key,
				{
					timestamp: bucketStart,
					metrics,
				},
			);
			return;
		}

		const { unshardedMetrics, shardMetrics, shardedMetrics } =
			splitMetricsForSharding(metrics, rules);

		const maxShards = Math.max(
			0,
			...shardedMetrics.map((metric) => metric.shardCount),
		);
		const storage = chunkedDurableObjectStorage(this.ctx.storage);
		await saveChunkedValue(storage, `${key}:manifest`, {
			timestamp: bucketStart,
			metrics: unshardedMetrics,
			shardedMetrics,
		});
		for (let index = 0; index < maxShards; index++) {
			await saveChunkedValue(storage, `${key}:shard:${index}`, {
				timestamp: bucketStart,
				metrics: shardMetrics.get(index) ?? [],
			});
		}
	}

	private async loadStorageBucket(
		key: string,
		bucketStart: string,
		rules: MetricShardRule[],
	): Promise<MetricDefinition[]> {
		const storage = chunkedDurableObjectStorage(this.ctx.storage);
		if (rules.length === 0) {
			const bucket = await loadChunkedValue(
				storage,
				key,
				StorageBucketPayloadSchema,
			);
			return bucket?.timestamp === bucketStart ? bucket.metrics : [];
		}

		const manifest = await loadChunkedValue(
			storage,
			`${key}:manifest`,
			ShardedStorageBucketManifestSchema,
		);
		if (manifest?.timestamp !== bucketStart) return [];

		const maxShards = Math.max(
			0,
			...manifest.shardedMetrics.map((metric) => metric.shardCount),
		);
		const metricGroups = [manifest.metrics];
		for (let index = 0; index < maxShards; index++) {
			const shard = await loadChunkedValue(
				storage,
				`${key}:shard:${index}`,
				StorageBucketPayloadSchema,
			);
			if (shard?.timestamp === bucketStart) metricGroups.push(shard.metrics);
		}

		return mergeMetricDefinitions(...metricGroups);
	}

	private async saveStateMetricShards(
		metrics: MetricDefinition[],
		rules: MetricShardRule[],
	): Promise<{ metrics: MetricDefinition[]; enabled: boolean }> {
		if (rules.length === 0) {
			return { metrics, enabled: false };
		}

		const { unshardedMetrics, shardMetrics, shardedMetrics } =
			splitMetricsForSharding(metrics, rules);
		if (shardedMetrics.length === 0) {
			return { metrics, enabled: false };
		}

		const maxShards = Math.max(
			0,
			...shardedMetrics.map((metric) => metric.shardCount),
		);
		const storage = chunkedDurableObjectStorage(this.ctx.storage);
		await saveChunkedValue(storage, `${STATE_METRIC_SHARDS_KEY}:manifest`, {
			metrics: unshardedMetrics,
			shardedMetrics,
		});
		for (let index = 0; index < maxShards; index++) {
			await saveChunkedValue(
				storage,
				`${STATE_METRIC_SHARDS_KEY}:shard:${index}`,
				{
					metrics: shardMetrics.get(index) ?? [],
				},
			);
		}

		return { metrics: unshardedMetrics, enabled: true };
	}

	private async loadStateMetricShards(
		metrics: MetricDefinition[],
	): Promise<MetricDefinition[]> {
		const storage = chunkedDurableObjectStorage(this.ctx.storage);
		const manifest = await loadChunkedValue(
			storage,
			`${STATE_METRIC_SHARDS_KEY}:manifest`,
			ShardedMetricManifestSchema,
		);
		if (manifest === undefined) return metrics;

		const maxShards = Math.max(
			0,
			...manifest.shardedMetrics.map((metric) => metric.shardCount),
		);
		const metricGroups = [manifest.metrics];
		for (let index = 0; index < maxShards; index++) {
			const shard = await loadChunkedValue(
				storage,
				`${STATE_METRIC_SHARDS_KEY}:shard:${index}`,
				MetricShardPayloadSchema,
			);
			if (shard !== undefined) metricGroups.push(shard.metrics);
		}

		return mergeMetricDefinitions(...metricGroups);
	}

	/** Fetch and persist sharded colo metric storage buckets for one delayed minute. */
	private async refreshShardedColoStorageBuckets(
		client: ReturnType<typeof getCloudflareMetricsClient>,
		state: MetricExporterState,
		config: ResolvedConfig,
		logger: Logger,
	): Promise<MetricFetchResult> {
		const timeRange = fixedMinuteRange(config);
		const shardRules = metricShardRulesForQuery(config, state.queryName);
		const partialErrors: unknown[] = [];
		const failedScopes = new Set<string>();
		const zoneRetryAfter: Record<string, number> = {};
		let firstError: unknown;
		let successfulBuckets = 0;

		for (const bucketRange of storageBucketRanges(timeRange)) {
			const bucketStart = new Date(bucketRange.mintime);
			const key = storageBucketKey(
				state.queryName,
				state.accountId,
				bucketStart,
			);

			try {
				const result = await this.fetchShardedColoMetrics(
					client,
					state,
					bucketRange,
					logger,
				);
				await this.saveStorageBucket(
					key,
					bucketRange.mintime,
					result.metrics,
					shardRules,
				);
				for (const error of result.partialErrors) partialErrors.push(error);
				for (const scope of result.failedScopes) failedScopes.add(scope);
				Object.assign(zoneRetryAfter, result.zoneRetryAfter);
				successfulBuckets++;
			} catch (error) {
				firstError ??= error;
				partialErrors.push(error);
				logger.error("Sharded colo timestamp query failed", {
					timestamp: bucketRange.mintime,
					shard_end: bucketRange.maxtime,
					error: error instanceof Error ? error.message : String(error),
				});
				try {
					await this.saveStorageBucket(
						key,
						bucketRange.mintime,
						[],
						shardRules,
					);
				} catch (storageError) {
					logger.error("Failed to clear stale sharded colo timestamp", {
						timestamp: bucketRange.mintime,
						error:
							storageError instanceof Error
								? storageError.message
								: String(storageError),
					});
				}
			}
		}

		if (successfulBuckets === 0 && firstError !== undefined) {
			throw firstError;
		}

		return {
			metrics: [],
			partialErrors,
			failedScopes,
			zoneRetryAfter,
		};
	}

	private async fetchShardedColoMetrics(
		client: ReturnType<typeof getCloudflareMetricsClient>,
		state: MetricExporterState,
		timeRange: TimeRange,
		logger: Logger,
	): Promise<MetricFetchResult> {
		const { accountName, zones } = state;
		let zonesToQuery = zones;
		if (isPaidTierGraphQLQuery(state.queryName)) {
			const { paid, free } = partitionZonesByTier(zones);
			if (free.length > 0) {
				logger.info("Skipping free tier zones for paid-tier query", {
					skipped_zones: free.map((z) => z.name),
					processing_zones: paid.length,
				});
			}
			zonesToQuery = paid;
		}

		if (zonesToQuery.length === 0) {
			return {
				metrics: [],
				partialErrors: [],
				failedScopes: new Set(),
				zoneRetryAfter: {},
			};
		}

		const ZONES_PER_CHUNK = 10;
		if (zonesToQuery.length <= ZONES_PER_CHUNK) {
			const zoneIds = zonesToQuery.map((z) => z.id);
			return {
				metrics: await client.getShardedColoMetrics(
					zoneIds,
					zonesToQuery,
					timeRange,
				),
				partialErrors: [],
				failedScopes: new Set(),
				zoneRetryAfter: {},
			};
		}

		const chunkResults: MetricDefinition[][] = [];
		const partialErrors: unknown[] = [];
		const failedScopes = new Set<string>();
		let firstChunkError: unknown;
		for (let i = 0; i < zonesToQuery.length; i += ZONES_PER_CHUNK) {
			const chunkZones = zonesToQuery.slice(i, i + ZONES_PER_CHUNK);
			const chunkIds = chunkZones.map((z) => z.id);

			try {
				chunkResults.push(
					await client.getShardedColoMetrics(chunkIds, chunkZones, timeRange),
				);
			} catch (error) {
				firstChunkError ??= error;
				partialErrors.push(error);
				for (const zone of chunkZones) failedScopes.add(zone.name);
				logger.error("Sharded colo zone chunk query failed", {
					query: state.queryName,
					account: accountName,
					chunk_index: Math.floor(i / ZONES_PER_CHUNK),
					chunk_size: chunkZones.length,
					total_zones: zonesToQuery.length,
					failed_zones: chunkZones.map((z) => z.name),
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		if (chunkResults.length === 0 && firstChunkError !== undefined) {
			throw firstChunkError;
		}

		return {
			metrics: mergeMetricDefinitions(...chunkResults),
			partialErrors,
			failedScopes,
			zoneRetryAfter: {},
		};
	}

	/**
	 * Fetch account-scoped metrics from Cloudflare API.
	 * Handles both account-level and zone-batched queries.
	 *
	 * @param client Cloudflare metrics client.
	 * @param state Current exporter state.
	 * @param timeRange Time range for metrics queries.
	 * @param config Resolved runtime configuration.
	 * @param logger Logger instance.
	 * @returns Array of metric definitions.
	 */
	private async fetchAccountScopedMetrics(
		client: ReturnType<typeof getCloudflareMetricsClient>,
		state: MetricExporterState,
		timeRange: TimeRange,
		config: ResolvedConfig,
		logger: Logger,
	): Promise<MetricFetchResult> {
		const { queryName, accountId, accountName, zones, firewallRules } = state;
		if (
			queryName === COLO_METRICS_QUERY_NAME &&
			metricShardRulesForQuery(config, queryName).length > 0
		) {
			return this.refreshShardedColoStorageBuckets(
				client,
				state,
				config,
				logger,
			);
		}

		// Account-level queries (worker-totals, logpush-account, magic-transit)
		if (isAccountLevelQuery(queryName)) {
			return {
				metrics: await client.getAccountMetrics(
					queryName,
					accountId,
					accountName,
					timeRange,
				),
				partialErrors: [],
				failedScopes: new Set(),
				zoneRetryAfter: {},
			};
		}

		// Zone-batched queries - fetch all zones in one GraphQL call
		if (isZoneLevelQuery(queryName)) {
			// Hostname metrics guardrails: parse allowlist once for both guard + query
			let hostMetricsAllowlist: ReadonlySet<string> | undefined;
			let hostMetricsDelaySeconds: number | undefined;
			if (queryName === "hostname-http-metrics") {
				const parsed = parseCommaSeparated(config.hostMetricsAllowlist);
				// Normalize to lowercase per spec
				const normalized = new Set([...parsed].map((h) => h.toLowerCase()));
				if (normalized.size === 0) {
					logger.debug("Hostname metrics disabled: empty allowlist");
					return {
						metrics: [],
						partialErrors: [],
						failedScopes: new Set(),
						zoneRetryAfter: {},
					};
				}
				if (normalized.size > MAX_HOSTNAME_ALLOWLIST_SIZE) {
					logger.error("Hostname allowlist exceeds maximum size", {
						size: normalized.size,
						max: MAX_HOSTNAME_ALLOWLIST_SIZE,
					});
					return {
						metrics: [],
						partialErrors: [],
						failedScopes: new Set(),
						zoneRetryAfter: {},
					};
				}
				// excludeHost strips host labels from all metrics in prometheus.ts,
				// which would collapse distinct hostnames into duplicate gauge series
				// (max-dedup keeps only the highest value, losing per-host granularity).
				if (config.excludeHost) {
					logger.warn(
						"Hostname metrics disabled: excludeHost=true strips host labels",
					);
					return {
						metrics: [],
						partialErrors: [],
						failedScopes: new Set(),
						zoneRetryAfter: {},
					};
				}
				hostMetricsAllowlist = normalized;
				hostMetricsDelaySeconds = config.hostMetricsDelaySeconds;
			}

			// Filter out free tier zones for paid-tier GraphQL queries
			let zonesToQuery = zones;
			if (isPaidTierGraphQLQuery(queryName)) {
				const { paid, free } = partitionZonesByTier(zones);

				if (free.length > 0) {
					logger.info("Skipping free tier zones for paid-tier query", {
						skipped_zones: free.map((z) => z.name),
						processing_zones: paid.length,
					});
				}

				zonesToQuery = paid;

				if (zonesToQuery.length === 0) {
					logger.info("No paid tier zones to query");
					return {
						metrics: [],
						partialErrors: [],
						failedScopes: new Set(),
						zoneRetryAfter: {},
					};
				}
			}

			// Cloudflare GraphQL API limits queries to 10 zones (zonesHardLimit).
			// Chunk zones and merge results to support accounts with >10 zones.
			const ZONES_PER_CHUNK = 10;

			if (zonesToQuery.length <= ZONES_PER_CHUNK) {
				const zoneIds = zonesToQuery.map((z) => z.id);
				return {
					metrics: await client.getZoneMetrics(
						queryName,
						zoneIds,
						zonesToQuery,
						firewallRules,
						timeRange,
						hostMetricsAllowlist,
						hostMetricsDelaySeconds,
						config.httpStatusGroup,
					),
					partialErrors: [],
					failedScopes: new Set(),
					zoneRetryAfter: {},
				};
			}

			const chunkResults: MetricDefinition[][] = [];
			const partialErrors: unknown[] = [];
			const failedScopes = new Set<string>();
			const currentZoneIds = new Set(zonesToQuery.map((zone) => zone.id));
			const now = Date.now();
			const zoneRetryAfter: Record<string, number> = {};
			for (const [zoneId, retryAfter] of Object.entries(state.zoneRetryAfter)) {
				if (currentZoneIds.has(zoneId) && retryAfter > now) {
					zoneRetryAfter[zoneId] = retryAfter;
				}
			}
			const queryableZones = zonesToQuery.filter((zone) => {
				const retryAfter = zoneRetryAfter[zone.id] ?? 0;
				if (retryAfter <= now) return true;
				failedScopes.add(zone.name);
				logger.debug("Skipping zone during product-access backoff", {
					query: queryName,
					zone: zone.name,
					retry_after: new Date(retryAfter).toISOString(),
				});
				return false;
			});
			let firstChunkError: unknown;
			let longestRetryError: unknown;
			let longestRetrySeconds = config.metricRefreshIntervalSeconds;
			for (let i = 0; i < queryableZones.length; i += ZONES_PER_CHUNK) {
				const chunkZones = queryableZones.slice(i, i + ZONES_PER_CHUNK);
				const chunkIds = chunkZones.map((z) => z.id);

				try {
					const metrics = await client.getZoneMetrics(
						queryName,
						chunkIds,
						chunkZones,
						firewallRules,
						timeRange,
						hostMetricsAllowlist,
						hostMetricsDelaySeconds,
						config.httpStatusGroup,
					);
					for (const zoneId of chunkIds) delete zoneRetryAfter[zoneId];
					chunkResults.push(metrics);
				} catch (error) {
					firstChunkError ??= error;
					partialErrors.push(error);
					for (const zone of chunkZones) failedScopes.add(zone.name);
					const retrySeconds = getMetricRefreshDelaySeconds(
						error,
						config.metricRefreshIntervalSeconds,
					);
					if (retrySeconds > longestRetrySeconds) {
						longestRetrySeconds = retrySeconds;
						longestRetryError = error;
					}
					if (retrySeconds > config.metricRefreshIntervalSeconds) {
						for (const zoneId of chunkIds) {
							zoneRetryAfter[zoneId] = now + retrySeconds * 1000;
						}
					}
					// Log and continue — partial results from other chunks are still valuable.
					logger.error("Zone chunk query failed", {
						query: queryName,
						chunk_index: Math.floor(i / ZONES_PER_CHUNK),
						chunk_size: chunkZones.length,
						total_zones: zonesToQuery.length,
						failed_zones: chunkZones.map((z) => z.name),
						error: error instanceof Error ? error.message : String(error),
						retry_seconds: retrySeconds,
					});
				}
			}

			if (chunkResults.length === 0 && firstChunkError !== undefined) {
				throw longestRetryError ?? firstChunkError;
			}
			return {
				metrics: mergeMetricDefinitions(...chunkResults),
				partialErrors,
				failedScopes,
				zoneRetryAfter,
			};
		}

		// Unknown query - should not happen if IDs are constructed correctly
		console.error("Unknown query type", { queryName });
		return {
			metrics: [],
			partialErrors: [],
			failedScopes: new Set(),
			zoneRetryAfter: {},
		};
	}

	/**
	 * Fetch zone-scoped metrics from Cloudflare API.
	 * Handles SSL certificates and load balancer weight metrics.
	 *
	 * @param client Cloudflare metrics client.
	 * @param state Current exporter state.
	 * @returns Array of metric definitions.
	 */
	private async fetchZoneScopedMetrics(
		client: ReturnType<typeof getCloudflareMetricsClient>,
		state: MetricExporterState,
	): Promise<MetricDefinition[]> {
		const { queryName, zoneMetadata } = state;

		if (zoneMetadata === null) {
			return [];
		}

		switch (queryName) {
			case "ssl-certificates":
				return client.getSSLCertificateMetricsForZone(zoneMetadata);
			case "lb-weight-metrics":
				return client.getLbWeightMetricsForZone(zoneMetadata);
			default:
				console.error("Unknown zone-scoped query", { queryName });
				return [];
		}
	}

	/** Persist state in bounded storage chunks before publishing it in memory. */
	private async saveState(state: MetricExporterState): Promise<void> {
		await saveChunkedValue(
			chunkedDurableObjectStorage(this.ctx.storage),
			STATE_KEY,
			state,
		);
	}

	/**
	 * Return cached accumulated metrics.
	 *
	 * @returns Current snapshot of metrics with accumulated counter values.
	 */
	async export(): Promise<MetricDefinition[]> {
		const state = this.getState();
		if (state.scopeType === "account") {
			return this.exportAccountScopedMetrics(state);
		}
		if (state.metricShardsEnabled) {
			return this.loadStateMetricShards(state.metrics);
		}
		return state.metrics;
	}

	private async exportAccountScopedMetrics(
		state: MetricExporterState,
	): Promise<MetricDefinition[]> {
		if (state.queryName !== COLO_METRICS_QUERY_NAME) {
			if (state.metricShardsEnabled) {
				return this.loadStateMetricShards(state.metrics);
			}
			return state.metrics;
		}

		const config = await getConfig(this.env);
		if (metricShardRulesForQuery(config, state.queryName).length > 0) {
			return this.exportShardedColoStorageBucket(state, config);
		}
		return state.metrics;
	}

	private async exportShardedColoStorageBucket(
		state: MetricExporterState,
		config: ResolvedConfig,
	): Promise<MetricDefinition[]> {
		if (state.scopeType !== "account") return [];
		const bucketStart = currentStorageBucketStart(config);
		const bucketStartString = bucketStart.toISOString();
		const key = storageBucketKey(state.queryName, state.accountId, bucketStart);
		return this.loadStorageBucket(
			key,
			bucketStartString,
			metricShardRulesForQuery(config, state.queryName),
		);
	}
}
