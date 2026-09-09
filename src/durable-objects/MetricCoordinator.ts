import { DurableObject } from "cloudflare:workers";
import { getCloudflareMetricsClient } from "../cloudflare/client";
import { extractErrorInfo } from "../lib/errors";
import { filterAccountsByIds, parseCommaSeparated } from "../lib/filters";
import { createLogger, type Logger } from "../lib/logger";
import type { MetricDefinition } from "../lib/metrics";
import {
	type SerializeOptions,
	serializeToPrometheus,
} from "../lib/prometheus";
import { getConfig, type ResolvedConfig } from "../lib/runtime-config";
import type { Account } from "../lib/types";
import { AccountMetricCoordinator } from "./AccountMetricCoordinator";
import type {
	PackedColoMetricRow,
	PackedColoMetricState,
} from "./MetricExporter";

const STATE_KEY = "state";
const STREAM_CHUNK_TARGET_BYTES = 64 * 1024;

type MetricCoordinatorState = {
	identifier: string;
	accounts: Account[];
	lastAccountFetch: number;
};

function formatPackedColoValue(value: number): string {
	if (Number.isNaN(value)) return "NaN";
	if (!Number.isFinite(value)) return value > 0 ? "+Inf" : "-Inf";
	return String(value);
}

function escapePackedColoLabel(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n");
}

function packedColoLabels(
	zone: string,
	row: PackedColoMetricRow,
	excludeHost: boolean,
): string {
	const labels = [
		`zone="${escapePackedColoLabel(zone)}"`,
		`colo="${escapePackedColoLabel(row.colo)}"`,
	];
	if (!excludeHost) {
		labels.push(`host="${escapePackedColoLabel(row.host)}"`);
	}
	return `{${labels.join(",")}}`;
}

function writePackedColoMetrics(
	states: readonly PackedColoMetricState[],
	options: SerializeOptions,
	write: (output: string) => void,
): void {
	const metrics = [
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

	const denylist = options.denylist ?? new Set<string>();
	const excludeHost = options.excludeLabels?.has("host") ?? false;
	let buffer = "";

	const flush = () => {
		if (buffer.length === 0) return;
		write(buffer);
		buffer = "";
	};
	const writeLine = (line: string) => {
		buffer += `${line}\n`;
		if (buffer.length >= STREAM_CHUNK_TARGET_BYTES) flush();
	};

	for (const metric of metrics) {
		if (denylist.has(metric.name)) continue;
		let wroteSample = false;
		let wroteHeaders = false;
		const writeSample = (line: string) => {
			if (!wroteHeaders) {
				writeLine(`# HELP ${metric.name} ${metric.help}`);
				writeLine(`# TYPE ${metric.name} counter`);
				wroteHeaders = true;
			}
			wroteSample = true;
			writeLine(line);
		};

		if (excludeHost) {
			const aggregated = new Map<
				string,
				{ zone: string; row: PackedColoMetricRow; value: number }
			>();
			for (const state of states) {
				for (const zoneBucket of state.zones) {
					for (const row of zoneBucket.rows) {
						const metricValue = {
							value: row[metric.valueKey],
							misses: row[metric.missesKey],
						};
						if (metricValue.misses === 0) continue;
						const key = `${zoneBucket.zone}\x00${row.colo}`;
						const existing = aggregated.get(key);
						if (existing === undefined) {
							aggregated.set(key, {
								zone: zoneBucket.zone,
								row,
								value: metricValue.value,
							});
						} else {
							existing.value += metricValue.value;
						}
					}
				}
			}
			for (const { zone, row, value } of aggregated.values()) {
				writeSample(
					`${metric.name}${packedColoLabels(zone, row, true)} ${formatPackedColoValue(value)}`,
				);
			}
		} else {
			for (const state of states) {
				for (const zoneBucket of state.zones) {
					for (const row of zoneBucket.rows) {
						const metricValue = {
							value: row[metric.valueKey],
							misses: row[metric.missesKey],
						};
						if (metricValue.misses === 0) continue;
						writeSample(
							`${metric.name}${packedColoLabels(zoneBucket.zone, row, false)} ${formatPackedColoValue(metricValue.value)}`,
						);
					}
				}
			}
		}

		if (wroteSample) writeLine("");
	}
	flush();
}

/**
 * Coordinates metrics collection across all Cloudflare accounts and maintains cached account list.
 */
export class MetricCoordinator extends DurableObject<Env> {
	private state: MetricCoordinatorState | undefined;

	/**
	 * Gets or creates singleton MetricCoordinator instance.
	 *
	 * @param env Worker environment bindings.
	 * @returns Initialized MetricCoordinator stub.
	 */
	static async get(env: Env) {
		const stub = env.MetricCoordinator.getByName("metric-coordinator");
		await stub.setIdentifier("metric-coordinator");
		return stub;
	}

	/**
	 * Constructs MetricCoordinator and initializes state from storage.
	 *
	 * @param ctx Durable Object state.
	 * @param env Worker environment bindings.
	 */
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.state = await ctx.storage.get<MetricCoordinatorState>(STATE_KEY);
		});
	}

	/**
	 * Creates logger instance with resolved configuration.
	 *
	 * @param config Resolved runtime configuration.
	 * @returns Logger instance.
	 */
	private createLogger(config: ResolvedConfig): Logger {
		return createLogger("metric_coordinator", {
			format: config.logFormat,
			level: config.logLevel,
		});
	}

	/**
	 * Initializes coordinator state if not already set.
	 *
	 * @param id Unique identifier for this coordinator instance.
	 */
	async setIdentifier(id: string): Promise<void> {
		if (this.state !== undefined) {
			return;
		}
		this.state = { identifier: id, accounts: [], lastAccountFetch: 0 };
		await this.ctx.storage.put(STATE_KEY, this.state);
	}

	/**
	 * Gets coordinator state.
	 *
	 * @returns Current coordinator state.
	 * @throws {Error} When state not initialized.
	 */
	private getState(): MetricCoordinatorState {
		if (this.state === undefined) {
			throw new Error("State not initialized");
		}
		return this.state;
	}

	/**
	 * Refreshes accounts from Cloudflare API if cache expired.
	 *
	 * @param config Resolved runtime configuration.
	 * @param logger Logger instance.
	 * @returns Cached or refreshed account list.
	 */
	private async refreshAccountsIfStale(
		config: ResolvedConfig,
		logger: Logger,
	): Promise<Account[]> {
		const state = this.getState();
		const ttlMs = config.accountListCacheTtlSeconds * 1000;

		if (
			state.accounts.length > 0 &&
			Date.now() - state.lastAccountFetch < ttlMs
		) {
			return state.accounts;
		}

		const client = getCloudflareMetricsClient(this.env);
		logger.info("Refreshing account list");
		const allAccounts = await client.getAccounts();

		// Filter accounts if whitelist is set
		const cfAccountsSet =
			config.cfAccounts !== null
				? parseCommaSeparated(config.cfAccounts)
				: null;
		const accounts =
			cfAccountsSet !== null
				? filterAccountsByIds(allAccounts, cfAccountsSet)
				: allAccounts;

		this.state = {
			...state,
			accounts,
			lastAccountFetch: Date.now(),
		};
		await this.ctx.storage.put(STATE_KEY, this.state);

		logger.info("Accounts cached", {
			total: allAccounts.length,
			filtered: accounts.length,
		});
		return accounts;
	}

	/**
	 * Collects metrics from all accounts and serializes to Prometheus format.
	 *
	 * @returns Prometheus-formatted metrics string.
	 */
	async export(): Promise<string> {
		const config = await getConfig(this.env);
		const logger = this.createLogger(config);

		logger.info("Collecting metrics");
		const accounts = await this.refreshAccountsIfStale(config, logger);

		if (accounts.length === 0) {
			logger.warn("No accounts found");
			return "";
		}

		logger.info("Exporting metrics", { account_count: accounts.length });
		const metricsDenylist = parseCommaSeparated(config.metricsDenylist);
		const excludeLabels = config.excludeHost ? new Set(["host"]) : undefined;

		// Track errors by account and error code
		const errorsByAccount: Map<string, { code: string; count: number }[]> =
			new Map();

		const results = await Promise.all(
			accounts.map(async (account) => {
				try {
					const coordinator = await AccountMetricCoordinator.get(
						account.id,
						account.name,
						this.env,
					);
					return await coordinator.exportForPrometheus();
				} catch (error) {
					const info = extractErrorInfo(error);
					logger.error("Failed to export account", {
						account_id: account.id,
						error_code: info.code,
						error: info.message,
						...(info.stack && { stack: info.stack }),
					});

					// Track error for metrics
					const accountErrors = errorsByAccount.get(account.id) ?? [];
					const existing = accountErrors.find((e) => e.code === info.code);
					if (existing) {
						existing.count++;
					} else {
						accountErrors.push({ code: info.code, count: 1 });
					}
					errorsByAccount.set(account.id, accountErrors);

					return {
						metrics: [],
						packedColoMetrics: [],
						zoneCounts: {
							total: 0,
							filtered: 0,
							processed: 0,
							skippedFreeTier: 0,
						},
					};
				}
			}),
		);

		// Aggregate stats
		const zoneCounts = {
			total: 0,
			filtered: 0,
			processed: 0,
			skippedFreeTier: 0,
		};
		const allMetrics: MetricDefinition[] = [];
		const packedColoMetrics: PackedColoMetricState[] = [];
		for (const result of results) {
			allMetrics.push(...result.metrics);
			packedColoMetrics.push(...result.packedColoMetrics);
			zoneCounts.total += result.zoneCounts.total;
			zoneCounts.filtered += result.zoneCounts.filtered;
			zoneCounts.processed += result.zoneCounts.processed;
			zoneCounts.skippedFreeTier += result.zoneCounts.skippedFreeTier;
		}

		// Add exporter info metrics
		const exporterMetrics = this.buildExporterInfoMetrics(
			accounts.length,
			zoneCounts,
			errorsByAccount,
		);

		const serializedMetrics = serializeToPrometheus(
			[...exporterMetrics, ...allMetrics],
			{
				denylist: metricsDenylist,
				excludeLabels,
			},
		);
		const packedOutput: string[] = [];
		writePackedColoMetrics(
			packedColoMetrics,
			{ denylist: metricsDenylist, excludeLabels },
			(output) => packedOutput.push(output),
		);
		return [...packedOutput, serializedMetrics]
			.filter((output) => output.length > 0)
			.join("\n");
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== "/export") {
			return new Response("Not Found", { status: 404 });
		}

		try {
			return await this.exportResponse();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return new Response(`Error collecting metrics: ${message}`, {
				status: 500,
			});
		}
	}

	private async exportResponse(): Promise<Response> {
		const config = await getConfig(this.env);
		const logger = this.createLogger(config);

		logger.info("Collecting metrics");
		const accounts = await this.refreshAccountsIfStale(config, logger);

		if (accounts.length === 0) {
			logger.warn("No accounts found");
			return new Response("", {
				headers: { "Content-Type": "text/plain; charset=utf-8" },
			});
		}

		logger.info("Streaming metrics", { account_count: accounts.length });

		return new Response(this.createExportStream(accounts, config, logger), {
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		});
	}

	private createExportStream(
		accounts: readonly Account[],
		config: ResolvedConfig,
		logger: Logger,
	): ReadableStream<Uint8Array> {
		const encoder = new TextEncoder();
		const metricsDenylist = parseCommaSeparated(config.metricsDenylist);
		const excludeLabels = config.excludeHost ? new Set(["host"]) : undefined;

		return new ReadableStream({
			start: async (controller) => {
				const errorsByAccount: Map<string, { code: string; count: number }[]> =
					new Map();
				const zoneCounts = {
					total: 0,
					filtered: 0,
					processed: 0,
					skippedFreeTier: 0,
				};
				const allMetrics: MetricDefinition[] = [];
				const packedColoMetrics: PackedColoMetricState[] = [];

				const writeRaw = (output: string) => {
					if (output.length === 0) return;
					controller.enqueue(encoder.encode(output));
				};
				const write = (output: string) => {
					if (output.length === 0) return;
					writeRaw(`${output}\n`);
				};

				try {
					for (const account of accounts) {
						try {
							const coordinator = await AccountMetricCoordinator.get(
								account.id,
								account.name,
								this.env,
							);
							const result = await coordinator.exportForPrometheus();
							allMetrics.push(...result.metrics);
							packedColoMetrics.push(...result.packedColoMetrics);
							zoneCounts.total += result.zoneCounts.total;
							zoneCounts.filtered += result.zoneCounts.filtered;
							zoneCounts.processed += result.zoneCounts.processed;
							zoneCounts.skippedFreeTier += result.zoneCounts.skippedFreeTier;
						} catch (error) {
							const info = extractErrorInfo(error);
							logger.error("Failed to export account", {
								account_id: account.id,
								error_code: info.code,
								error: info.message,
								...(info.stack && { stack: info.stack }),
							});

							const accountErrors = errorsByAccount.get(account.id) ?? [];
							const existing = accountErrors.find((e) => e.code === info.code);
							if (existing) {
								existing.count++;
							} else {
								accountErrors.push({ code: info.code, count: 1 });
							}
							errorsByAccount.set(account.id, accountErrors);
						}
					}

					writePackedColoMetrics(
						packedColoMetrics,
						{ denylist: metricsDenylist, excludeLabels },
						writeRaw,
					);
					write(
						serializeToPrometheus(
							[
								...this.buildExporterInfoMetrics(
									accounts.length,
									zoneCounts,
									errorsByAccount,
								),
								...allMetrics,
							],
							{
								denylist: metricsDenylist,
								excludeLabels,
							},
						),
					);
					logger.info("Metrics streamed successfully");
					controller.close();
				} catch (error) {
					controller.error(error);
				}
			},
		});
	}

	/**
	 * Builds exporter health and discovery metrics.
	 *
	 * @param accountCount Number of accounts discovered.
	 * @param zoneCounts Zone counts (total, filtered, processed, skippedFreeTier).
	 * @param errorsByAccount Errors by account and error code.
	 * @returns Exporter info metrics.
	 */
	private buildExporterInfoMetrics(
		accountCount: number,
		zoneCounts: {
			total: number;
			filtered: number;
			processed: number;
			skippedFreeTier: number;
		},
		errorsByAccount: Map<string, { code: string; count: number }[]>,
	): MetricDefinition[] {
		const metrics: MetricDefinition[] = [
			{
				name: "cloudflare_exporter_up",
				help: "Exporter health",
				type: "gauge",
				values: [{ labels: {}, value: 1 }],
			},
			{
				name: "cloudflare_accounts",
				help: "Total accounts discovered",
				type: "gauge",
				values: [{ labels: {}, value: accountCount }],
			},
			{
				name: "cloudflare_zones",
				help: "Total zones before filtering",
				type: "gauge",
				values: [{ labels: {}, value: zoneCounts.total }],
			},
			{
				name: "cloudflare_zones_filtered",
				help: "Zones after whitelist filter",
				type: "gauge",
				values: [{ labels: {}, value: zoneCounts.filtered }],
			},
			{
				name: "cloudflare_zones_processed",
				help: "Zones successfully processed",
				type: "gauge",
				values: [{ labels: {}, value: zoneCounts.processed }],
			},
			{
				name: "cloudflare_zones_skipped_free_tier",
				help: "Zones skipped due to free tier plan (no GraphQL analytics access)",
				type: "gauge",
				values: [{ labels: {}, value: zoneCounts.skippedFreeTier }],
			},
		];

		// Add error metrics if any errors occurred
		if (errorsByAccount.size > 0) {
			const errorsMetric: MetricDefinition = {
				name: "cloudflare_exporter_errors_total",
				help: "Total errors during metric collection by account and error code",
				type: "counter",
				values: [],
			};

			for (const [accountId, errors] of errorsByAccount) {
				for (const { code, count } of errors) {
					errorsMetric.values.push({
						labels: { account_id: accountId, error_code: code },
						value: count,
					});
				}
			}

			metrics.push(errorsMetric);
		}

		return metrics;
	}
}
