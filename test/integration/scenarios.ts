export type ColoMetricScenario = Readonly<{
	name: string;
	path: Readonly<{
		metric: "colo-metrics";
		operations: readonly ["refresh", "read"];
	}>;
	scale: Readonly<{
		zones: number;
		colosPerZone: number;
		hostsPerColo: number;
		trafficPerHost: Readonly<{
			requests: number;
			visits: number;
			responseBytes: number;
		}>;
	}>;
}>;

export type RequestMethodMetricScenario = Readonly<{
	name: string;
	path: Readonly<{
		metric: "request-method-metrics";
		operations: readonly ["refresh", "read"];
	}>;
	scale: Readonly<{
		zones: number;
		methodsPerZone: number;
		requestsPerMethod: number;
	}>;
}>;

export type CacheMissMetricScenario = Readonly<{
	name: string;
	path: Readonly<{
		metric: "cache-miss-metrics";
		operations: readonly ["refresh", "read"];
	}>;
	scale: Readonly<{
		zones: number;
		countriesPerZone: number;
		hostsPerCountry: number;
		trafficPerHost: Readonly<{
			count: number;
			avgOriginDurationMs: number;
		}>;
	}>;
}>;

export type ColoErrorMetricScenario = Readonly<{
	name: string;
	path: Readonly<{
		metric: "colo-error-metrics";
		operations: readonly ["refresh", "read"];
	}>;
	scale: Readonly<{
		zones: number;
		colosPerZone: number;
		hostsPerColo: number;
		statusesPerHost: number;
		trafficPerSeries: Readonly<{
			requests: number;
			visits: number;
			responseBytes: number;
		}>;
	}>;
}>;

export type LogpushZoneMetricScenario = Readonly<{
	name: string;
	path: Readonly<{
		metric: "logpush-zone";
		operations: readonly ["refresh", "read"];
	}>;
	scale: Readonly<{
		zones: number;
		jobsPerZone: number;
		failureCount: number;
	}>;
}>;

export type SSLCertificateMetricScenario = Readonly<{
	name: string;
	path: Readonly<{
		metric: "ssl-certificates";
		operations: readonly ["refresh", "read"];
	}>;
	scale: Readonly<{
		certificatesPerZone: number;
	}>;
}>;

export type LbWeightMetricScenario = Readonly<{
	name: string;
	path: Readonly<{
		metric: "lb-weight-metrics";
		operations: readonly ["refresh", "read"];
	}>;
	scale: Readonly<{
		loadBalancersPerZone: number;
		poolsPerLoadBalancer: number;
		originsPerPool: number;
		enabledOriginsPerPool: number;
		weight: number;
	}>;
}>;

// Add a case here using business traffic dimensions; the test derives records.
export const COLO_METRIC_SCENARIOS = [
	{
		name: "small colo account",
		path: {
			metric: "colo-metrics",
			operations: ["refresh", "read"],
		},
		scale: {
			zones: 1,
			colosPerZone: 10,
			hostsPerColo: 10,
			trafficPerHost: {
				requests: 10,
				visits: 8,
				responseBytes: 2_048,
			},
		},
	},
	{
		name: "large colo account",
		path: {
			metric: "colo-metrics",
			operations: ["refresh", "read"],
		},
		scale: {
			zones: 15,
			colosPerZone: 10,
			hostsPerColo: 1_000,
			trafficPerHost: {
				requests: 10,
				visits: 8,
				responseBytes: 2_048,
			},
		},
	},
] satisfies readonly ColoMetricScenario[];

export const REQUEST_METHOD_METRIC_SCENARIOS = [
	{
		name: "small request method account",
		path: {
			metric: "request-method-metrics",
			operations: ["refresh", "read"],
		},
		scale: {
			zones: 1,
			methodsPerZone: 8,
			requestsPerMethod: 10,
		},
	},
	{
		name: "large request method account",
		path: {
			metric: "request-method-metrics",
			operations: ["refresh", "read"],
		},
		scale: {
			zones: 15,
			methodsPerZone: 2_000,
			requestsPerMethod: 10,
		},
	},
] satisfies readonly RequestMethodMetricScenario[];

export const CACHE_MISS_METRIC_SCENARIOS = [
	{
		name: "small cache miss account",
		path: {
			metric: "cache-miss-metrics",
			operations: ["refresh", "read"],
		},
		scale: {
			zones: 1,
			countriesPerZone: 10,
			hostsPerCountry: 10,
			trafficPerHost: {
				count: 10,
				avgOriginDurationMs: 800,
			},
		},
	},
	{
		name: "large cache miss account",
		path: {
			metric: "cache-miss-metrics",
			operations: ["refresh", "read"],
		},
		scale: {
			zones: 15,
			countriesPerZone: 10,
			hostsPerCountry: 1_000,
			trafficPerHost: {
				count: 10,
				avgOriginDurationMs: 800,
			},
		},
	},
] satisfies readonly CacheMissMetricScenario[];

export const COLO_ERROR_METRIC_SCENARIOS = [
	{
		name: "small colo error account",
		path: {
			metric: "colo-error-metrics",
			operations: ["refresh", "read"],
		},
		scale: {
			zones: 1,
			colosPerZone: 10,
			hostsPerColo: 10,
			statusesPerHost: 3,
			trafficPerSeries: {
				requests: 10,
				visits: 8,
				responseBytes: 2_048,
			},
		},
	},
	{
		name: "large colo error account",
		path: {
			metric: "colo-error-metrics",
			operations: ["refresh", "read"],
		},
		scale: {
			zones: 15,
			colosPerZone: 10,
			hostsPerColo: 200,
			statusesPerHost: 2,
			trafficPerSeries: {
				requests: 10,
				visits: 8,
				responseBytes: 2_048,
			},
		},
	},
] satisfies readonly ColoErrorMetricScenario[];

export const LOGPUSH_ZONE_METRIC_SCENARIOS = [
	{
		name: "small logpush zone account",
		path: {
			metric: "logpush-zone",
			operations: ["refresh", "read"],
		},
		scale: {
			zones: 1,
			jobsPerZone: 20,
			failureCount: 3,
		},
	},
	{
		name: "large logpush zone account",
		path: {
			metric: "logpush-zone",
			operations: ["refresh", "read"],
		},
		scale: {
			zones: 15,
			jobsPerZone: 2_000,
			failureCount: 3,
		},
	},
] satisfies readonly LogpushZoneMetricScenario[];

export const SSL_CERTIFICATE_METRIC_SCENARIOS = [
	{
		name: "small ssl certificate zone",
		path: {
			metric: "ssl-certificates",
			operations: ["refresh", "read"],
		},
		scale: {
			certificatesPerZone: 10,
		},
	},
	{
		name: "large ssl certificate zone",
		path: {
			metric: "ssl-certificates",
			operations: ["refresh", "read"],
		},
		scale: {
			certificatesPerZone: 10_000,
		},
	},
] satisfies readonly SSLCertificateMetricScenario[];

export const LB_WEIGHT_METRIC_SCENARIOS = [
	{
		name: "small lb weight zone",
		path: {
			metric: "lb-weight-metrics",
			operations: ["refresh", "read"],
		},
		scale: {
			loadBalancersPerZone: 5,
			poolsPerLoadBalancer: 2,
			originsPerPool: 3,
			enabledOriginsPerPool: 2,
			weight: 0.75,
		},
	},
	{
		name: "large lb weight zone",
		path: {
			metric: "lb-weight-metrics",
			operations: ["refresh", "read"],
		},
		scale: {
			loadBalancersPerZone: 100,
			poolsPerLoadBalancer: 10,
			originsPerPool: 20,
			enabledOriginsPerPool: 10,
			weight: 0.75,
		},
	},
] satisfies readonly LbWeightMetricScenario[];
