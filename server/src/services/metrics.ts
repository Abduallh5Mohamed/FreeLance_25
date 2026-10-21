/**
 * M8 Q4 — Prometheus metrics registry.
 *
 * A tiny, dependency-free registry supporting counters, histograms and gauges,
 * plus externally injected gauge sources for values that are sampled at scrape
 * time (queue/job lag, pool saturation, ...). Values are rendered in the
 * Prometheus text exposition format.
 *
 * Design constraints:
 *  - HTTP metrics are dimensioned by the route TEMPLATE (not the raw path), a
 *    whitelisted METHOD (unknown verbs collapse into one `other` bucket) and the
 *    status CLASS, so cardinality stays bounded even for caller-controlled
 *    values.
 *  - Label sets are validated at the call site: an unexpected label is a
 *    programming error and throws, so a stray user value can never create an
 *    unbounded series.
 *  - A metric may be defined once with a fixed type/label set; a conflicting
 *    redefinition throws.
 *  - Observations of non-finite numbers are ignored; counters only move up.
 */

export type Labels = Record<string, string>;

const METRIC_NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export const DEFAULT_DURATION_BUCKETS: readonly number[] = [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

export interface Counter {
    readonly name: string;
    inc(labels?: Labels, value?: number): void;
}

export interface Histogram {
    readonly name: string;
    observe(labels: Labels, value: number): void;
}

export interface Gauge {
    readonly name: string;
    set(labels: Labels, value: number): void;
    inc(labels?: Labels, value?: number): void;
    dec(labels?: Labels, value?: number): void;
}

export interface GaugeSample {
    labels?: Labels;
    value: number;
}

/** A gauge whose samples are computed on demand at render time. */
export interface GaugeSource {
    name: string;
    help: string;
    labelNames?: readonly string[];
    collect(): GaugeSample[];
}

export interface MetricsRegistry {
    counter(name: string, help: string, labelNames?: readonly string[]): Counter;
    histogram(name: string, help: string, labelNames: readonly string[], buckets?: readonly number[]): Histogram;
    gauge(name: string, help: string, labelNames?: readonly string[]): Gauge;
    registerGaugeSource(source: GaugeSource): void;
    render(): string;
}

type MetricType = 'counter' | 'histogram' | 'gauge';

interface CounterSeries { labels: Labels; value: number; }
interface GaugeSeries { labels: Labels; value: number; }
interface HistogramSeries { labels: Labels; counts: number[]; sum: number; count: number; }

interface Descriptor {
    name: string;
    type: MetricType;
    help: string;
    labelNames: readonly string[];
    buckets: readonly number[];
    counters: Map<string, CounterSeries>;
    gauges: Map<string, GaugeSeries>;
    histograms: Map<string, HistogramSeries>;
}

const assertMetricName = (name: string): void => {
    if (!METRIC_NAME_PATTERN.test(name)) throw new Error(`Invalid metric name: ${name}`);
};

const assertLabelNames = (labelNames: readonly string[]): void => {
    for (const labelName of labelNames) {
        if (!LABEL_NAME_PATTERN.test(labelName)) throw new Error(`Invalid label name: ${labelName}`);
    }
};

const labelKey = (labelNames: readonly string[], labels: Labels): string => {
    for (const provided of Object.keys(labels)) {
        if (!labelNames.includes(provided)) throw new Error(`Unexpected label "${provided}"`);
    }
    return labelNames.map((name) => {
        const value = labels[name];
        if (value === undefined) throw new Error(`Missing label "${name}"`);
        if (typeof value !== 'string') throw new Error(`Label "${name}" must be a string`);
        return `${name}\u001f${value}`;
    }).join('\u0001');
};

const escapeLabelValue = (value: string): string =>
    value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');

const formatLabels = (labels: Labels): string => {
    const names = Object.keys(labels).sort();
    if (names.length === 0) return '';
    const body = names.map((name) => `${name}="${escapeLabelValue(labels[name])}"`).join(',');
    return `{${body}}`;
};

const formatValue = (value: number): string => {
    if (!Number.isFinite(value)) return '0';
    return Number.isInteger(value) ? String(value) : String(value);
};

const isDescriptorType = (descriptor: Descriptor | undefined, type: MetricType): boolean =>
    descriptor !== undefined && descriptor.type === type;

export function createMetricsRegistry(options: { defaultBuckets?: readonly number[] } = {}): MetricsRegistry {
    const definitions = new Map<string, Descriptor>();
    const gaugeSources: GaugeSource[] = [];
    const normalizedBuckets = (buckets: readonly number[] | undefined): readonly number[] => {
        const chosen = (buckets ?? options.defaultBuckets ?? DEFAULT_DURATION_BUCKETS)
            .filter((bound) => Number.isFinite(bound) && bound > 0);
        return chosen.length > 0 ? [...chosen].sort((a, b) => a - b) : [...DEFAULT_DURATION_BUCKETS];
    };

    const define = (
        name: string,
        type: MetricType,
        help: string,
        labelNames: readonly string[],
        buckets: readonly number[] = [],
    ): Descriptor => {
        assertMetricName(name);
        assertLabelNames(labelNames);
        const existing = definitions.get(name);
        if (existing) {
            if (existing.type !== type) throw new Error(`Metric ${name} already defined as ${existing.type}`);
            if (existing.labelNames.join(',') !== labelNames.join(',')) {
                throw new Error(`Metric ${name} already defined with different labels`);
            }
            return existing;
        }
        const descriptor: Descriptor = {
            name, type, help, labelNames, buckets,
            counters: new Map(), gauges: new Map(), histograms: new Map(),
        };
        definitions.set(name, descriptor);
        return descriptor;
    };

    return {
        counter(name, help, labelNames = []) {
            const descriptor = define(name, 'counter', help, labelNames);
            return {
                name,
                inc(labels: Labels = {}, value = 1) {
                    if (!Number.isFinite(value) || value <= 0) return;
                    const key = labelKey(labelNames, labels);
                    const series = descriptor.counters.get(key) ?? { labels: { ...labels }, value: 0 };
                    series.value += value;
                    descriptor.counters.set(key, series);
                },
            };
        },
        histogram(name, help, labelNames, buckets) {
            const resolvedBuckets = normalizedBuckets(buckets);
            const descriptor = define(name, 'histogram', help, labelNames, resolvedBuckets);
            return {
                name,
                observe(labels: Labels, value: number) {
                    if (!Number.isFinite(value)) return;
                    const key = labelKey(labelNames, labels);
                    const series = descriptor.histograms.get(key) ?? {
                        labels: { ...labels },
                        counts: new Array(descriptor.buckets.length).fill(0) as number[],
                        sum: 0,
                        count: 0,
                    };
                    const bounded = Math.max(0, value);
                    const index = descriptor.buckets.findIndex((bound) => bounded <= bound);
                    if (index !== -1) series.counts[index] += 1;
                    series.sum += bounded;
                    series.count += 1;
                    descriptor.histograms.set(key, series);
                },
            };
        },
        gauge(name, help, labelNames = []) {
            const descriptor = define(name, 'gauge', help, labelNames);
            const current = (labels: Labels): GaugeSeries => {
                const key = labelKey(labelNames, labels);
                return descriptor.gauges.get(key) ?? { labels: { ...labels }, value: 0 };
            };
            return {
                name,
                set(labels: Labels = {}, value: number) {
                    if (!Number.isFinite(value)) return;
                    const key = labelKey(labelNames, labels);
                    descriptor.gauges.set(key, { labels: { ...labels }, value });
                },
                inc(labels: Labels = {}, value = 1) {
                    if (!Number.isFinite(value)) return;
                    const series = current(labels);
                    series.value += value;
                    descriptor.gauges.set(labelKey(labelNames, labels), series);
                },
                dec(labels: Labels = {}, value = 1) {
                    if (!Number.isFinite(value)) return;
                    const series = current(labels);
                    series.value -= value;
                    descriptor.gauges.set(labelKey(labelNames, labels), series);
                },
            };
        },
        registerGaugeSource(source) {
            assertMetricName(source.name);
            if (source.labelNames) assertLabelNames(source.labelNames);
            if (gaugeSources.some((existing) => existing.name === source.name)) return;
            gaugeSources.push(source);
        },
        render() {
            const lines: string[] = [];
            const descriptors = [...definitions.values()].sort((a, b) => a.name.localeCompare(b.name));
            for (const descriptor of descriptors) {
                lines.push(`# HELP ${descriptor.name} ${descriptor.help}`);
                lines.push(`# TYPE ${descriptor.name} ${descriptor.type}`);
                if (descriptor.type === 'counter') {
                    for (const series of sortedSeries(descriptor.counters)) {
                        lines.push(`${descriptor.name}${formatLabels(series.labels)} ${formatValue(series.value)}`);
                    }
                } else if (descriptor.type === 'gauge') {
                    for (const series of sortedSeries(descriptor.gauges)) {
                        lines.push(`${descriptor.name}${formatLabels(series.labels)} ${formatValue(series.value)}`);
                    }
                } else {
                    for (const series of sortedSeries(descriptor.histograms)) {
                        let cumulative = 0;
                        for (let index = 0; index < descriptor.buckets.length; index += 1) {
                            cumulative += series.counts[index];
                            lines.push(`${descriptor.name}_bucket${formatLabels({ ...series.labels, le: String(descriptor.buckets[index]) })} ${formatValue(cumulative)}`);
                        }
                        lines.push(`${descriptor.name}_bucket${formatLabels({ ...series.labels, le: '+Inf' })} ${formatValue(series.count)}`);
                        lines.push(`${descriptor.name}_sum${formatLabels(series.labels)} ${formatValue(series.sum)}`);
                        lines.push(`${descriptor.name}_count${formatLabels(series.labels)} ${formatValue(series.count)}`);
                    }
                }
            }
            for (const source of [...gaugeSources].sort((a, b) => a.name.localeCompare(b.name))) {
                let samples: GaugeSample[] = [];
                try {
                    samples = source.collect();
                } catch {
                    samples = [];
                }
                lines.push(`# HELP ${source.name} ${source.help}`);
                lines.push(`# TYPE ${source.name} gauge`);
                const rendered = samples
                    .filter((sample) => Number.isFinite(sample.value))
                    .map((sample) => `${source.name}${formatLabels(sample.labels ?? {})} ${formatValue(sample.value)}`)
                    .sort();
                lines.push(...rendered);
            }
            return lines.length > 0 ? `${lines.join('\n')}\n` : '';
        },
    };
}

const sortedSeries = <T extends { labels: Labels }>(series: Map<string, T>): T[] =>
    [...series.values()].sort((a, b) => formatLabels(a.labels).localeCompare(formatLabels(b.labels)));

/* ----------------------------------------------------------------------- */
/* HTTP request instrumentation (route template + status class).            */
/* ----------------------------------------------------------------------- */

export interface HttpRequestObservation {
    method: string;
    /** Resolved route template (never the raw path). */
    route: string;
    status: number;
    durationMs: number;
}

export interface HttpObserver {
    observe(observation: HttpRequestObservation): void;
}

export const HTTP_REQUESTS_METRIC = 'http_requests_total';
export const HTTP_DURATION_METRIC = 'http_request_duration_seconds';

/** The single bucket every unrecognized HTTP verb collapses into. */
export const HTTP_METHOD_FALLBACK = 'other';

/** Standard HTTP methods that may appear as a `method` label value. */
const BOUNDED_HTTP_METHODS: readonly string[] = [
    'GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE',
];

/**
 * Maps an inbound request method to a bounded label value. The label is
 * caller-controlled, so anything outside the standard set (a forged verb, a
 * non-string value, an empty string) collapses into the single
 * `HTTP_METHOD_FALLBACK` bucket: cardinality stays bounded no matter what a
 * client sends.
 */
export function boundedHttpMethod(method: unknown): string {
    if (typeof method !== 'string') return HTTP_METHOD_FALLBACK;
    const normalized = method.toUpperCase();
    return BOUNDED_HTTP_METHODS.includes(normalized) ? normalized : HTTP_METHOD_FALLBACK;
}

export function createHttpObserver(
    registry: MetricsRegistry,
    options: { buckets?: readonly number[] } = {},
): HttpObserver {
    const requests = registry.counter(
        HTTP_REQUESTS_METRIC,
        'Total HTTP requests by method, route template and status class.',
        ['method', 'route', 'status_class'],
    );
    const duration = registry.histogram(
        HTTP_DURATION_METRIC,
        'HTTP request duration in seconds by method, route template and status class.',
        ['method', 'route', 'status_class'],
        options.buckets,
    );
    return {
        observe(observation) {
            const labels: Labels = {
                method: boundedHttpMethod(observation.method),
                route: observation.route,
                status_class: statusClass(observation.status),
            };
            requests.inc(labels);
            duration.observe(labels, Math.max(0, observation.durationMs) / 1000);
        },
    };
}

/** Maps a status code to its class (`2xx`, `4xx`, ...); non-codes are `unknown`. */
export const statusClass = (status: number): string => {
    if (!Number.isInteger(status) || status < 100 || status > 599) return 'unknown';
    return `${Math.floor(status / 100)}xx`;
};
