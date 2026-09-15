import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getCloudflareMetricsClient } from "../cloudflare/client";
import { MetricExporter } from "./MetricExporter";

class AlarmStorage {
	readonly setAlarm = vi.fn().mockResolvedValue(undefined);
	getManyFailures = 0;
	readonly values = new Map<string, unknown>();

	async get(keyOrKeys: string | string[]): Promise<unknown> {
		if (this.getManyFailures > 0) {
			this.getManyFailures--;
			throw new Error("state storage unavailable");
		}
		if (typeof keyOrKeys === "string") return this.values.get(keyOrKeys);
		const result = new Map<string, unknown>();
		for (const key of keyOrKeys) {
			if (this.values.has(key)) result.set(key, this.values.get(key));
		}
		return result;
	}

	async put(entries: Record<string, unknown>): Promise<void> {
		for (const [key, value] of Object.entries(entries)) {
			this.values.set(key, structuredClone(value));
		}
	}

	async delete(keys: string[]): Promise<void> {
		for (const key of keys) this.values.delete(key);
	}
}

function createExporter(
	storage: AlarmStorage,
	envOverrides: Record<string, unknown> = {},
): {
	exporter: MetricExporter;
	ready: Promise<void>;
} {
	let ready = Promise.resolve();
	const ctx = {
		storage,
		blockConcurrencyWhile(callback: () => Promise<void>) {
			ready = callback();
		},
	};
	const env = {
		LOG_FORMAT: "json",
		LOG_LEVEL: "error",
		...envOverrides,
	};
	return {
		exporter: new MetricExporter(
			ctx as unknown as DurableObjectState,
			env as unknown as Env,
		),
		ready,
	};
}

function storedState(): Record<string, unknown> {
	return {
		scopeType: "account",
		scopeId: "account-id",
		queryName: "worker-totals",
		counters: {},
		metrics: [],
		lastIngest: 0,
		accountId: "account-id",
		accountName: "Account",
		zones: [],
		firewallRules: {},
		zoneMetadata: null,
		refreshInterval: 60,
		lastRefresh: 0,
		lastError: null,
		lastSslFetch: 0,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("MetricExporter state recovery", () => {
	it("schedules recovery when constructor state loading keeps failing", async () => {
		const storage = new AlarmStorage();
		storage.getManyFailures = 2;
		const { exporter, ready } = createExporter(storage);
		await ready;

		await expect(exporter.alarm()).resolves.toBeUndefined();

		expect(storage.setAlarm).toHaveBeenCalledOnce();
	});

	it("backs off only a denied zone chunk while refreshing successful chunks", async () => {
		const storage = new AlarmStorage();
		const zones = Array.from({ length: 11 }, (_, index) => ({
			id: `zone-${index}`,
			name: `zone-${index}.example.com`,
			status: "active",
			plan: { id: "paid", name: "Paid" },
			account: { id: "account-id", name: "Account" },
		}));
		storage.values.set("state", {
			...storedState(),
			queryName: "adaptive-metrics",
			zones,
		});
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						errors: [
							{
								message: "zone does not have access to the path",
								extensions: { code: "FORBIDDEN" },
							},
						],
					}),
					{ headers: { "content-type": "application/json" } },
				),
			)
			.mockResolvedValue(
				new Response(JSON.stringify({ data: { viewer: { zones: [] } } }), {
					headers: { "content-type": "application/json" },
				}),
			);
		vi.stubGlobal("fetch", fetch);
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
		const rateLimiter = { limit: vi.fn().mockResolvedValue({ success: true }) };
		const { exporter, ready } = createExporter(storage, {
			CLOUDFLARE_API_TOKEN: "token",
			CONFIG_KV: { get: vi.fn().mockResolvedValue(null) },
			CF_API_RATE_LIMITER: rateLimiter,
		});
		await ready;

		await exporter.alarm();
		await exporter.alarm();

		expect(fetch).toHaveBeenCalledTimes(3);
		expect(storage.setAlarm).toHaveBeenCalledTimes(2);
		consoleLog.mockRestore();
		vi.unstubAllGlobals();
	});

	it("does not double-count when the platform retries the same alarm window", async () => {
		const storage = new AlarmStorage();
		const zone = {
			id: "zone-id",
			name: "example.com",
			status: "active",
			plan: { id: "paid", name: "Paid" },
			account: { id: "account-id", name: "Account" },
		};
		storage.values.set("state", { ...storedState(), zones: [zone] });
		storage.setAlarm
			.mockRejectedValueOnce(new Error("ordinary alarm scheduling failed"))
			.mockRejectedValueOnce(new Error("recovery alarm scheduling failed"));
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					data: {
						viewer: {
							accounts: [
								{
									workersInvocationsAdaptive: [
										{
											dimensions: { scriptName: "worker" },
											sum: { requests: 42, errors: 0 },
											quantiles: null,
										},
									],
								},
							],
						},
					},
				}),
				{ headers: { "content-type": "application/json" } },
			),
		);
		vi.stubGlobal("fetch", fetch);
		vi.spyOn(console, "log").mockImplementation(() => {});
		const rateLimiter = { limit: vi.fn().mockResolvedValue({ success: true }) };
		const { exporter, ready } = createExporter(storage, {
			CLOUDFLARE_API_TOKEN: "token",
			CONFIG_KV: { get: vi.fn().mockResolvedValue(null) },
			CF_API_RATE_LIMITER: rateLimiter,
		});
		await ready;

		await expect(exporter.alarm()).rejects.toThrow(
			"recovery alarm scheduling failed",
		);
		await exporter.alarm();

		const metrics = await exporter.export();
		const requests = metrics.find(
			(metric) => metric.name === "cloudflare_worker_requests_total",
		);
		expect(requests?.values[0]?.value).toBe(42);
	});

	it("retries a transient constructor load before initialize can overwrite state", async () => {
		const storage = new AlarmStorage();
		storage.getManyFailures = 1;
		storage.values.set("state", storedState());
		const { exporter, ready } = createExporter(storage);
		await ready;

		await exporter.initialize("account:account-id:worker-totals");

		await expect(exporter.export()).resolves.toEqual([]);
	});
});

// Exercise real refresh, storage codecs, and GraphQL translation; only the
// platform boundary and upstream HTTP response are replaced by local fixtures.
async function createColoHarness(zoneCount = 1) {
	const storage = new AlarmStorage();
	const zone = {
		id: "zone-id",
		name: "example.com",
		status: "active",
		plan: { id: "paid", name: "Paid" },
		account: { id: "account-id", name: "Account" },
	};
	const zones = Array.from({ length: zoneCount }, (_, index) => ({
		...zone,
		id: index === 0 ? zone.id : `zone-${index}`,
		name: index === 0 ? zone.name : `zone-${index}.example.com`,
	}));
	storage.values.set("state", {
		...storedState(),
		queryName: "colo-metrics",
		zones,
	});
	let packed = false;
	let observations = [
		{ host: "www.example.com", visits: 10, requests: 10, bytes: 10 },
	];
	const queries: string[] = [];
	vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
		const body = String(init?.body);
		queries.push(body);
		const requested = new Set<string>(
			z
				.object({ variables: z.object({ zoneIDs: z.array(z.string()) }) })
				.parse(JSON.parse(body)).variables.zoneIDs,
		);
		return new Response(
			JSON.stringify({
				data: {
					viewer: {
						zones: zones
							.filter((zone) => requested.has(zone.id))
							.map((zone) => ({
								zoneTag: zone.id,
								httpRequestsAdaptiveGroups: observations.map((row) => ({
									dimensions: {
										coloCode: "SJC",
										clientRequestHTTPHost: row.host,
									},
									count: row.requests,
									sum: { visits: row.visits, edgeResponseBytes: row.bytes },
								})),
							})),
					},
				},
			}),
			{ headers: { "content-type": "application/json" } },
		);
	});
	vi.spyOn(console, "log").mockImplementation(() => {});
	const env = {
		CLOUDFLARE_API_TOKEN: "test-token",
		CONFIG_KV: {
			get: async () => JSON.stringify({ coloMetricsPackedStorage: packed }),
		},
		CF_API_RATE_LIMITER: { limit: async () => ({ success: true }) },
	};
	let { exporter, ready } = createExporter(storage, env);
	await ready;
	return {
		storage,
		queries,
		get exporter() {
			return exporter;
		},
		setPacked(enabled: boolean) {
			packed = enabled;
		},
		setObservations(rows: typeof observations) {
			observations = rows;
		},
		async restart() {
			({ exporter, ready } = createExporter(storage, env));
			await ready;
		},
		async refresh(minute: number) {
			await exporter.triggerRefresh({
				mintime: new Date(1735689600000 + (minute - 1) * 60_000).toISOString(),
				maxtime: new Date(1735689600000 + minute * 60_000).toISOString(),
			});
		},
		async requests() {
			const packed = await exporter.exportPackedMetrics();
			if (packed !== undefined && packed.queryName !== "colo-metrics") {
				throw new Error("expected a packed colo snapshot");
			}
			return packed?.zones[0]?.requests;
		},
	};
}

describe("MetricExporter packed colo storage", () => {
	it("accumulates packed counters across refreshes and restarts without double-counting retries", async () => {
		const h = await createColoHarness();
		h.setPacked(true);
		await h.refresh(1);
		await h.refresh(2);
		await h.restart();
		await h.refresh(2);
		expect(await h.requests()).toEqual([20]);
		expect(
			h.queries.every((query) => query.includes("ColoMetricsPackedStorage")),
		).toBe(true);
	});

	it("expires packed counters absent for five refreshes, aging once per window", async () => {
		const h = await createColoHarness();
		h.setPacked(true);
		await h.refresh(1);
		h.setObservations([]);
		await h.refresh(2);
		await h.refresh(2);
		const snapshot = await h.exporter.exportPackedMetrics();
		if (snapshot !== undefined && snapshot.queryName !== "colo-metrics") {
			throw new Error("expected a packed colo snapshot");
		}
		expect(snapshot?.zones[0]?.misses).toEqual([4]);
		for (let minute = 3; minute <= 6; minute++) await h.refresh(minute);
		const expired = await h.exporter.exportPackedMetrics();
		if (expired !== undefined && expired.queryName !== "colo-metrics") {
			throw new Error("expected a packed colo snapshot");
		}
		expect(expired?.zones).toEqual([]);
	});

	it("round-trips 150,000 packed rows (450,000 samples) within the storage guard", async () => {
		const h = await createColoHarness(15);
		h.setPacked(true);
		h.setObservations(
			Array.from({ length: 10_000 }, (_, index) => ({
				host: `host-${index}.example.com`,
				visits: 10,
				requests: 10,
				bytes: 10,
			})),
		);
		await h.refresh(1);
		await h.restart();
		expect(h.storage.values.get("state")).toMatchObject({ lastError: null });
		const snapshot = await h.exporter.exportPackedMetrics();
		if (snapshot !== undefined && snapshot.queryName !== "colo-metrics") {
			throw new Error("expected a packed colo snapshot");
		}
		expect(
			snapshot?.zones.reduce((total, zone) => total + zone.misses.length, 0),
		).toBe(150_000);
		const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
		expect(bytes).toBeLessThan(16 * 1024 * 1024);
		expect(h.storage.values.get("packed-colo-metrics:manifest")).toMatchObject({
			bytes,
		});
	}, 15_000);

	it("starts a fresh packed generation after the flag was disabled", async () => {
		const h = await createColoHarness();
		h.setPacked(true);
		await h.refresh(1);
		expect(await h.requests()).toEqual([10]);
		h.setPacked(false);
		await h.refresh(2);
		expect(await h.exporter.exportPackedMetrics()).toBeUndefined();
		expect(
			[...h.storage.values.keys()].filter((key) =>
				key.startsWith("packed-colo-metrics"),
			),
		).toEqual([]);
		h.setPacked(true);
		await h.refresh(3);
		expect(await h.requests()).toEqual([10]);
	});
});

// Exercise the real refresh, storage codec, and GraphQL translation for the
// origin-status packed path; only the platform boundary and upstream HTTP
// response are replaced by local fixtures.
async function createOriginStatusHarness() {
	const storage = new AlarmStorage();
	const zone = {
		id: "zone-id",
		name: "example.com",
		status: "active",
		plan: { id: "paid", name: "Paid" },
		account: { id: "account-id", name: "Account" },
	};
	storage.values.set("state", {
		...storedState(),
		queryName: "origin-status-metrics",
		zones: [zone],
	});
	let packed = false;
	let observations = [
		{ status: 200, country: "US", host: "a.example.com", count: 10 },
	];
	vi.stubGlobal("fetch", async () => {
		return new Response(
			JSON.stringify({
				data: {
					viewer: {
						zones: [
							{
								zoneTag: zone.id,
								httpRequestsAdaptiveGroups: observations.map((row) => ({
									dimensions: {
										originResponseStatus: row.status,
										clientCountryName: row.country,
										clientRequestHTTPHost: row.host,
									},
									count: row.count,
								})),
							},
						],
					},
				},
			}),
			{ headers: { "content-type": "application/json" } },
		);
	});
	vi.spyOn(console, "log").mockImplementation(() => {});
	const env = {
		CLOUDFLARE_API_TOKEN: "test-token",
		CONFIG_KV: {
			get: async () => JSON.stringify({ packedMetricStorage: packed }),
		},
		CF_API_RATE_LIMITER: { limit: async () => ({ success: true }) },
	};
	let { exporter, ready } = createExporter(storage, env);
	await ready;
	return {
		storage,
		get exporter() {
			return exporter;
		},
		setPacked(enabled: boolean) {
			packed = enabled;
		},
		setObservations(rows: typeof observations) {
			observations = rows;
		},
		async restart() {
			({ exporter, ready } = createExporter(storage, env));
			await ready;
		},
		async refresh(minute: number) {
			await exporter.triggerRefresh({
				mintime: new Date(1735689600000 + (minute - 1) * 60_000).toISOString(),
				maxtime: new Date(1735689600000 + minute * 60_000).toISOString(),
			});
		},
		async snapshot() {
			const state = await exporter.exportPackedMetrics();
			if (state !== undefined && state.queryName !== "origin-status-metrics") {
				throw new Error("expected a packed origin status snapshot");
			}
			return state;
		},
	};
}

describe("MetricExporter packed origin status storage", () => {
	it("stores one row per status, country and host under its own key", async () => {
		const h = await createOriginStatusHarness();
		h.setPacked(true);
		h.setObservations([
			{ status: 200, country: "US", host: "a.example.com", count: 1 },
			{ status: 502, country: "DE", host: "b.example.com", count: 2 },
		]);
		await h.refresh(1);

		const snapshot = await h.snapshot();
		expect(snapshot?.zones[0]).toMatchObject({
			zone: "example.com",
			originStatus: ["200", "502"],
			country: ["US", "DE"],
			host: ["a.example.com", "b.example.com"],
			requests: [1, 2],
		});
		// Packed counters live outside the generic state, which stays empty.
		expect(h.storage.values.get("state")).toMatchObject({
			metrics: [],
			counters: {},
			lastError: null,
		});
		expect([...h.storage.values.keys()]).toContain(
			"packed-origin-status-metrics",
		);
		expect([...h.storage.values.keys()]).not.toContain("packed-colo-metrics");
	});

	it("accumulates across refreshes and restarts without double-counting retries", async () => {
		const h = await createOriginStatusHarness();
		h.setPacked(true);
		await h.refresh(1);
		await h.refresh(2);
		await h.restart();
		await h.refresh(2);

		expect((await h.snapshot())?.zones[0]?.requests).toEqual([20]);
	});

	it("keeps rows out of storage when the flag is disabled", async () => {
		const h = await createOriginStatusHarness();
		await h.refresh(1);

		expect(await h.snapshot()).toBeUndefined();
		expect([...h.storage.values.keys()]).not.toContain(
			"packed-origin-status-metrics",
		);
		// The unpacked path still accumulates into the generic state.
		const metrics = await h.exporter.export();
		expect(
			metrics.find(
				(metric) =>
					metric.name ===
					"cloudflare_zone_requests_origin_status_country_host_total",
			)?.values[0],
		).toMatchObject({ value: 10 });
	});

	it("starts a fresh packed generation after the flag was disabled", async () => {
		const h = await createOriginStatusHarness();
		h.setPacked(true);
		await h.refresh(1);
		expect((await h.snapshot())?.zones[0]?.requests).toEqual([10]);

		h.setPacked(false);
		await h.refresh(2);
		expect(await h.snapshot()).toBeUndefined();
		expect(
			[...h.storage.values.keys()].filter((key) =>
				key.startsWith("packed-origin-status-metrics"),
			),
		).toEqual([]);

		h.setPacked(true);
		await h.refresh(3);
		expect((await h.snapshot())?.zones[0]?.requests).toEqual([10]);
	});
});

async function createAdaptiveHarness() {
	const storage = new AlarmStorage();
	const zone = {
		id: "zone-id",
		name: "example.com",
		status: "active",
		plan: { id: "paid", name: "Paid" },
		account: { id: "account-id", name: "Account" },
	};
	storage.values.set("state", {
		...storedState(),
		queryName: "adaptive-metrics",
		zones: [zone],
	});
	let packed = false;
	let observations = [
		{
			status: 404,
			country: "US",
			host: "a.example.com",
			count: 3,
			avgOriginDurationMs: 1200,
		},
		{
			status: 500,
			country: "DE",
			host: "b.example.com",
			count: 2,
			avgOriginDurationMs: 900,
		},
	];
	vi.stubGlobal(
		"fetch",
		async () =>
			new Response(
				JSON.stringify({
					data: {
						viewer: {
							zones: [
								{
									zoneTag: zone.id,
									httpRequestsAdaptiveGroups: observations.map((row) => ({
										dimensions: {
											originResponseStatus: row.status,
											clientCountryName: row.country,
											clientRequestHTTPHost: row.host,
										},
										count: row.count,
										avg: {
											originResponseDurationMs: row.avgOriginDurationMs,
										},
									})),
								},
							],
						},
					},
				}),
				{ headers: { "content-type": "application/json" } },
			),
	);
	const env = {
		CLOUDFLARE_API_TOKEN: "test-token",
		CONFIG_KV: {
			get: async () => JSON.stringify({ packedMetricStorage: packed }),
		},
		CF_API_RATE_LIMITER: { limit: async () => ({ success: true }) },
	};
	let { exporter, ready } = createExporter(storage, env);
	await ready;
	return {
		storage,
		get exporter() {
			return exporter;
		},
		setPacked(enabled: boolean) {
			packed = enabled;
		},
		setObservations(rows: typeof observations) {
			observations = rows;
		},
		async restart() {
			({ exporter, ready } = createExporter(storage, env));
			await ready;
		},
		async refresh(minute: number) {
			await exporter.triggerRefresh({
				mintime: new Date(1735689600000 + (minute - 1) * 60_000).toISOString(),
				maxtime: new Date(1735689600000 + minute * 60_000).toISOString(),
			});
		},
		async snapshot() {
			const state = await exporter.exportPackedMetrics();
			if (state !== undefined && state.queryName !== "adaptive-metrics") {
				throw new Error("expected a packed adaptive snapshot");
			}
			return state;
		},
	};
}

describe("MetricExporter packed adaptive storage", () => {
	it("stores compact rows and keeps generic metrics empty", async () => {
		const h = await createAdaptiveHarness();
		h.setPacked(true);
		await h.refresh(1);

		expect((await h.snapshot())?.zones).toEqual([
			{
				zone: "example.com",
				status: ["404", "500"],
				country: ["US", "DE"],
				host: ["a.example.com", "b.example.com"],
				count: [3, 2],
				avgOriginDurationMs: [1200, 900],
				errors4xx: 3,
				errors5xx: 2,
			},
		]);
		expect(h.storage.values.get("state")).toMatchObject({
			metrics: [],
			lastError: null,
		});
		expect([...h.storage.values.keys()]).toContain("packed-adaptive-metrics");
	});

	it("accumulates counter rows across refreshes and keeps current rate inputs", async () => {
		const h = await createAdaptiveHarness();
		h.setPacked(true);
		await h.refresh(1);
		await h.refresh(2);

		expect((await h.snapshot())?.zones[0]).toMatchObject({
			count: [6, 4],
			errors4xx: 3,
			errors5xx: 2,
		});
	});

	it("starts a fresh packed generation after the flag was disabled", async () => {
		const h = await createAdaptiveHarness();
		h.setPacked(true);
		await h.refresh(1);
		expect((await h.snapshot())?.zones[0]?.count).toEqual([3, 2]);

		h.setPacked(false);
		await h.refresh(2);
		expect(await h.snapshot()).toBeUndefined();

		h.setPacked(true);
		await h.refresh(3);
		expect((await h.snapshot())?.zones[0]?.count).toEqual([3, 2]);
	});
});

async function createRequestMethodHarness() {
	const storage = new AlarmStorage();
	const zone = {
		id: "zone-id",
		name: "example.com",
		status: "active",
		plan: { id: "paid", name: "Paid" },
		account: { id: "account-id", name: "Account" },
	};
	storage.values.set("state", {
		...storedState(),
		queryName: "request-method-metrics",
		zones: [zone],
	});
	let packed = false;
	let observations = [
		{ method: "GET", count: 10 },
		{ method: "POST", count: 2 },
	];
	vi.stubGlobal(
		"fetch",
		async () =>
			new Response(
				JSON.stringify({
					data: {
						viewer: {
							zones: [
								{
									zoneTag: zone.id,
									httpRequestsAdaptiveGroups: observations.map((row) => ({
										dimensions: {
											clientRequestHTTPMethodName: row.method,
										},
										count: row.count,
									})),
								},
							],
						},
					},
				}),
				{ headers: { "content-type": "application/json" } },
			),
	);
	const env = {
		CLOUDFLARE_API_TOKEN: "test-token",
		CONFIG_KV: {
			get: async () => JSON.stringify({ packedMetricStorage: packed }),
		},
		CF_API_RATE_LIMITER: { limit: async () => ({ success: true }) },
	};
	const { exporter, ready } = createExporter(storage, env);
	await ready;
	return {
		storage,
		get exporter() {
			return exporter;
		},
		setPacked(enabled: boolean) {
			packed = enabled;
		},
		setObservations(rows: typeof observations) {
			observations = rows;
		},
		async refresh(minute: number) {
			await exporter.triggerRefresh({
				mintime: new Date(1735689600000 + (minute - 1) * 60_000).toISOString(),
				maxtime: new Date(1735689600000 + minute * 60_000).toISOString(),
			});
		},
		async snapshot() {
			const state = await exporter.exportPackedMetrics();
			if (state !== undefined && state.queryName !== "request-method-metrics") {
				throw new Error("expected a packed request method snapshot");
			}
			return state;
		},
	};
}

describe("MetricExporter packed request method storage", () => {
	it("stores one row per method and keeps generic metrics empty", async () => {
		const h = await createRequestMethodHarness();
		h.setPacked(true);
		await h.refresh(1);

		expect((await h.snapshot())?.zones).toEqual([
			{
				zone: "example.com",
				rows: [
					{ method: "GET", count: 10 },
					{ method: "POST", count: 2 },
				],
			},
		]);
		expect(h.storage.values.get("state")).toMatchObject({
			metrics: [],
			lastError: null,
		});
		expect([...h.storage.values.keys()]).toContain(
			"packed-request-method-metrics",
		);
	});

	it("accumulates across refreshes from compact state", async () => {
		const h = await createRequestMethodHarness();
		h.setPacked(true);
		await h.refresh(1);
		await h.refresh(2);

		expect((await h.snapshot())?.zones[0]?.rows).toEqual([
			{ method: "GET", count: 20 },
			{ method: "POST", count: 4 },
		]);
	});

	it("uses the legacy metric family when the flag is disabled", async () => {
		const h = await createRequestMethodHarness();
		await h.refresh(1);

		expect(await h.snapshot()).toBeUndefined();
		expect(await h.exporter.export()).toEqual([
			{
				name: "cloudflare_zone_requests_by_method_total",
				help: "Requests by HTTP method",
				type: "counter",
				values: [
					{
						labels: { zone: "example.com", method: "GET" },
						value: 10,
					},
					{
						labels: { zone: "example.com", method: "POST" },
						value: 2,
					},
				],
			},
		]);
	});
});

async function createCacheMissHarness() {
	const storage = new AlarmStorage();
	const zone = {
		id: "zone-id",
		name: "example.com",
		status: "active",
		plan: { id: "paid", name: "Paid" },
		account: { id: "account-id", name: "Account" },
	};
	storage.values.set("state", {
		...storedState(),
		queryName: "cache-miss-metrics",
		zones: [zone],
	});
	let packed = false;
	let observations = [
		{
			country: "US",
			host: "a.example.com",
			count: 3,
			avgOriginDurationMs: 900,
		},
		{
			country: "DE",
			host: "b.example.com",
			count: 0,
			avgOriginDurationMs: 400,
		},
	];
	vi.stubGlobal(
		"fetch",
		async () =>
			new Response(
				JSON.stringify({
					data: {
						viewer: {
							zones: [
								{
									zoneTag: zone.id,
									httpRequestsAdaptiveGroups: observations.map((row) => ({
										dimensions: {
											clientCountryName: row.country,
											clientRequestHTTPHost: row.host,
										},
										count: row.count,
										avg: {
											originResponseDurationMs: row.avgOriginDurationMs,
										},
									})),
								},
							],
						},
					},
				}),
				{ headers: { "content-type": "application/json" } },
			),
	);
	const env = {
		CLOUDFLARE_API_TOKEN: "test-token",
		CONFIG_KV: {
			get: async () => JSON.stringify({ packedMetricStorage: packed }),
		},
		CF_API_RATE_LIMITER: { limit: async () => ({ success: true }) },
	};
	const { exporter, ready } = createExporter(storage, env);
	await ready;
	return {
		storage,
		get exporter() {
			return exporter;
		},
		setPacked(enabled: boolean) {
			packed = enabled;
		},
		setObservations(rows: typeof observations) {
			observations = rows;
		},
		async refresh(minute: number) {
			await exporter.triggerRefresh({
				mintime: new Date(1735689600000 + (minute - 1) * 60_000).toISOString(),
				maxtime: new Date(1735689600000 + minute * 60_000).toISOString(),
			});
		},
		async snapshot() {
			const state = await exporter.exportPackedMetrics();
			if (state !== undefined && state.queryName !== "cache-miss-metrics") {
				throw new Error("expected a packed cache miss snapshot");
			}
			return state;
		},
	};
}

describe("MetricExporter packed cache miss storage", () => {
	it("stores compact rows and keeps generic metrics empty", async () => {
		const h = await createCacheMissHarness();
		h.setPacked(true);
		await h.refresh(1);

		expect((await h.snapshot())?.zones).toEqual([
			{
				zone: "example.com",
				rows: [
					{
						country: "US",
						host: "a.example.com",
						count: 3,
						avgOriginDurationMs: 900,
					},
					{
						country: "DE",
						host: "b.example.com",
						count: 0,
						avgOriginDurationMs: 400,
					},
				],
			},
		]);
		expect(h.storage.values.get("state")).toMatchObject({
			metrics: [],
			counters: {},
			lastError: null,
		});
		expect([...h.storage.values.keys()]).toContain("packed-cache-miss-metrics");
	});

	it("uses the legacy gauge metric when the flag is disabled", async () => {
		const h = await createCacheMissHarness();
		await h.refresh(1);

		expect(await h.snapshot()).toBeUndefined();
		expect(await h.exporter.export()).toEqual([
			{
				name: "cloudflare_zone_cache_miss_origin_duration_seconds",
				help: "Average origin response duration on cache miss in seconds",
				type: "gauge",
				values: [
					{
						labels: {
							zone: "example.com",
							country: "US",
							host: "a.example.com",
						},
						value: 0.9,
					},
				],
			},
		]);
	});
});

describe("MetricExporter additional packed storage", () => {
	it("stores logpush zone snapshots without generic metrics", async () => {
		const storage = new AlarmStorage();
		const zone = {
			id: "zone-id",
			name: "example.com",
			status: "active",
			plan: { id: "paid", name: "Paid" },
			account: { id: "account-id", name: "Account" },
		};
		storage.values.set("state", {
			...storedState(),
			queryName: "logpush-zone",
			zones: [zone],
		});
		let packed = false;
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					JSON.stringify({
						data: {
							viewer: {
								zones: [
									{
										zoneTag: zone.id,
										logpushHealthAdaptiveGroups: [
											{
												dimensions: {
													jobId: 23,
													destinationType: "s3",
												},
												count: 4,
											},
										],
									},
								],
							},
						},
					}),
					{ headers: { "content-type": "application/json" } },
				),
		);
		const env = {
			CLOUDFLARE_API_TOKEN: "test-token",
			CONFIG_KV: {
				get: async () => JSON.stringify({ packedMetricStorage: packed }),
			},
			CF_API_RATE_LIMITER: { limit: async () => ({ success: true }) },
		};
		const { exporter, ready } = createExporter(storage, env);
		await ready;

		packed = true;
		await exporter.triggerRefresh({
			mintime: new Date(1735689600000).toISOString(),
			maxtime: new Date(1735689660000).toISOString(),
		});

		const snapshot = await exporter.exportPackedMetrics();
		if (snapshot !== undefined && snapshot.queryName !== "logpush-zone") {
			throw new Error("expected a packed logpush zone snapshot");
		}
		expect(snapshot?.zones).toEqual([
			{
				zone: "example.com",
				rows: [{ jobId: "23", destinationType: "s3", count: 4 }],
			},
		]);
		expect(await exporter.export()).toEqual([]);
	});

	it("stores ssl certificate snapshots from zone exporters", async () => {
		const storage = new AlarmStorage();
		const zone = {
			id: "zone-id",
			name: "example.com",
			status: "active",
			plan: { id: "paid", name: "Paid" },
			account: { id: "account-id", name: "Account" },
		};
		storage.values.set("state", {
			...storedState(),
			scopeType: "zone",
			scopeId: zone.id,
			queryName: "ssl-certificates",
			zoneMetadata: zone,
		});
		const rateLimiter = { limit: async () => ({ success: true }) };
		const env = {
			CLOUDFLARE_API_TOKEN: "test-token",
			CONFIG_KV: {
				get: async () => JSON.stringify({ packedMetricStorage: true }),
			},
			CF_API_RATE_LIMITER: rateLimiter,
		};
		const client = getCloudflareMetricsClient({
			LOG_FORMAT: "json",
			LOG_LEVEL: "error",
			...env,
		} as unknown as Env);
		vi.spyOn(client, "getPackedSSLCertificateZone").mockResolvedValue({
			zone: zone.name,
			rows: [
				{
					type: "advanced",
					issuer: "letsencrypt",
					status: "active",
					expiresOnSeconds: 1_735_689_600,
				},
			],
		});
		const { exporter, ready } = createExporter(storage, env);
		await ready;

		await exporter.triggerRefresh({
			mintime: new Date(1735689600000).toISOString(),
			maxtime: new Date(1735689660000).toISOString(),
		});

		const snapshot = await exporter.exportPackedMetrics();
		if (snapshot !== undefined && snapshot.queryName !== "ssl-certificates") {
			throw new Error("expected a packed ssl certificates snapshot");
		}
		expect(snapshot?.zones).toEqual([
			{
				zone: "example.com",
				rows: [
					{
						type: "advanced",
						issuer: "letsencrypt",
						status: "active",
						expiresOnSeconds: 1_735_689_600,
					},
				],
			},
		]);
		expect(await exporter.export()).toEqual([]);
	});

	it("stores load balancer weight snapshots from zone exporters", async () => {
		const storage = new AlarmStorage();
		const zone = {
			id: "zone-id",
			name: "example.com",
			status: "active",
			plan: { id: "paid", name: "Paid" },
			account: { id: "account-id", name: "Account" },
		};
		storage.values.set("state", {
			...storedState(),
			scopeType: "zone",
			scopeId: zone.id,
			queryName: "lb-weight-metrics",
			zoneMetadata: zone,
		});
		const rateLimiter = { limit: async () => ({ success: true }) };
		const env = {
			CLOUDFLARE_API_TOKEN: "test-token",
			CONFIG_KV: {
				get: async () => JSON.stringify({ packedMetricStorage: true }),
			},
			CF_API_RATE_LIMITER: rateLimiter,
		};
		const client = getCloudflareMetricsClient({
			LOG_FORMAT: "json",
			LOG_LEVEL: "error",
			...env,
		} as unknown as Env);
		vi.spyOn(client, "getPackedLbWeightZone").mockResolvedValue({
			zone: zone.name,
			rows: [
				{
					lbName: "public",
					poolName: "primary",
					originName: "app-1",
					weight: 0.75,
				},
			],
		});
		const { exporter, ready } = createExporter(storage, env);
		await ready;

		await exporter.triggerRefresh({
			mintime: new Date(1735689600000).toISOString(),
			maxtime: new Date(1735689660000).toISOString(),
		});

		const snapshot = await exporter.exportPackedMetrics();
		if (snapshot !== undefined && snapshot.queryName !== "lb-weight-metrics") {
			throw new Error("expected a packed lb weight snapshot");
		}
		expect(snapshot?.zones).toEqual([
			{
				zone: "example.com",
				rows: [
					{
						lbName: "public",
						poolName: "primary",
						originName: "app-1",
						weight: 0.75,
					},
				],
			},
		]);
		expect(await exporter.export()).toEqual([]);
	});
});
