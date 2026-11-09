"use strict";
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
 *    redefinition throws. Rendered series names (including a histogram's
 *    derived *_bucket/*_sum/*_count families) must stay unique across ALL
 *    definitions and registered gauge sources; a cross-family collision
 *    throws at definition time either declaration order.
 *  - Histograms reject duplicate bounds and the reserved `le` label; distinct
 *    label-value tuples can never share a series key (JSON tuple encoding).
 *  - Observations of non-finite numbers are ignored; counters only move up.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.statusClass = exports.HTTP_METHOD_FALLBACK = exports.HTTP_DURATION_METRIC = exports.HTTP_REQUESTS_METRIC = exports.MAX_GAUGE_SOURCE_SAMPLES = exports.DEFAULT_DURATION_BUCKETS = void 0;
exports.createMetricsRegistry = createMetricsRegistry;
exports.boundedHttpMethod = boundedHttpMethod;
exports.createHttpObserver = createHttpObserver;
const METRIC_NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
exports.DEFAULT_DURATION_BUCKETS = [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];
const assertMetricName = (name) => {
    if (!METRIC_NAME_PATTERN.test(name))
        throw new Error(`Invalid metric name: ${name}`);
};
const assertLabelNames = (labelNames) => {
    for (const labelName of labelNames) {
        if (!LABEL_NAME_PATTERN.test(labelName))
            throw new Error(`Invalid label name: ${labelName}`);
    }
};
/**
 * Deterministic series key. JSON-encoding the ordered (name, value) tuple is
 * injective on label-value tuples (control characters such as \u0001 and
 * \u001f are escaped), so raw concatenation with delimiter characters can no
 * longer merge two distinct tuples into one series.
 */
const labelKey = (labelNames, labels) => {
    for (const provided of Object.keys(labels)) {
        if (!labelNames.includes(provided))
            throw new Error(`Unexpected label "${provided}"`);
    }
    return JSON.stringify(labelNames.map((name) => {
        const value = labels[name];
        if (value === undefined)
            throw new Error(`Missing label "${name}"`);
        if (typeof value !== 'string')
            throw new Error(`Label "${name}" must be a string`);
        return [name, value];
    }));
};
const escapeLabelValue = (value) => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const formatLabels = (labels) => {
    const names = Object.keys(labels).sort();
    if (names.length === 0)
        return '';
    const body = names.map((name) => `${name}="${escapeLabelValue(labels[name])}"`).join(',');
    return `{${body}}`;
};
const formatValue = (value) => {
    if (!Number.isFinite(value))
        return '0';
    return Number.isInteger(value) ? String(value) : String(value);
};
const isDescriptorType = (descriptor, type) => descriptor !== undefined && descriptor.type === type;
const renderedSeriesNames = (definition) => {
    if (definition.type === 'histogram') {
        return [definition.name, `${definition.name}_bucket`, `${definition.name}_sum`, `${definition.name}_count`];
    }
    return [definition.name];
};
const renderedNamesCollide = (a, b) => renderedSeriesNames(a).some((name) => renderedSeriesNames(b).includes(name));
const GAUGE_SOURCE_TYPE = 'gauge';
exports.MAX_GAUGE_SOURCE_SAMPLES = 10000;
const isValidGaugeSample = (source, sample) => {
    if (typeof sample !== 'object' || sample === null)
        return false;
    const candidate = sample;
    if (typeof candidate.value !== 'number' || !Number.isFinite(candidate.value))
        return false;
    const declared = source.labelNames ?? null;
    const labels = candidate.labels ?? {};
    if (typeof labels !== 'object' || labels === null)
        return false;
    const provided = labels;
    for (const [name, value] of Object.entries(provided)) {
        if (typeof value !== 'string')
            return false;
        if (!LABEL_NAME_PATTERN.test(name))
            return false;
        if (declared !== null && !declared.includes(name))
            return false;
    }
    if (declared !== null) {
        for (const name of declared) {
            if (!(name in provided))
                return false;
        }
    }
    return true;
};
function createMetricsRegistry(options = {}) {
    const definitions = new Map();
    const gaugeSources = [];
    const normalizedBuckets = (buckets) => {
        const chosen = (buckets ?? options.defaultBuckets ?? exports.DEFAULT_DURATION_BUCKETS)
            .filter((bound) => Number.isFinite(bound) && bound > 0);
        const sorted = [...chosen].sort((a, b) => a - b);
        if (sorted.length === 0)
            return [...exports.DEFAULT_DURATION_BUCKETS];
        // Duplicate bounds would render two identical `le=` samples for the
        // same series (the second per-equal-bound counter is never
        // incremented), so equal neighbours collapse to one bound.
        return sorted.filter((bound, index) => index === 0 || sorted[index - 1] !== bound);
    };
    const define = (name, type, help, labelNames, buckets = []) => {
        assertMetricName(name);
        assertLabelNames(labelNames);
        if (type === 'histogram' && labelNames.includes('le')) {
            // Rendering injects the bucket cut as `le`, overwriting any
            // user-provided `le` and collapsing distinct series into one
            // sample identity, so the reserved label is rejected up front.
            throw new Error(`Histogram ${name} must not use the reserved label "le"`);
        }
        const existing = definitions.get(name);
        if (existing) {
            if (existing.type !== type)
                throw new Error(`Metric ${name} already defined as ${existing.type}`);
            if (existing.labelNames.join(',') !== labelNames.join(',')) {
                throw new Error(`Metric ${name} already defined with different labels`);
            }
            return existing;
        }
        for (const descriptor of definitions.values()) {
            if (renderedNamesCollide({ name, type }, descriptor)) {
                throw new Error(`Metric ${name} collides with defined metric ${descriptor.name}`);
            }
        }
        for (const source of gaugeSources) {
            if (renderedNamesCollide({ name, type }, { name: source.name, type: GAUGE_SOURCE_TYPE })) {
                throw new Error(`Metric ${name} collides with registered gauge source ${source.name}`);
            }
        }
        const descriptor = {
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
                inc(labels = {}, value = 1) {
                    if (!Number.isFinite(value) || value <= 0)
                        return;
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
                observe(labels, value) {
                    if (!Number.isFinite(value))
                        return;
                    const key = labelKey(labelNames, labels);
                    const series = descriptor.histograms.get(key) ?? {
                        labels: { ...labels },
                        counts: new Array(descriptor.buckets.length).fill(0),
                        sum: 0,
                        count: 0,
                    };
                    const bounded = Math.max(0, value);
                    const index = descriptor.buckets.findIndex((bound) => bounded <= bound);
                    if (index !== -1)
                        series.counts[index] += 1;
                    series.sum += bounded;
                    series.count += 1;
                    descriptor.histograms.set(key, series);
                },
            };
        },
        gauge(name, help, labelNames = []) {
            const descriptor = define(name, 'gauge', help, labelNames);
            const current = (labels) => {
                const key = labelKey(labelNames, labels);
                return descriptor.gauges.get(key) ?? { labels: { ...labels }, value: 0 };
            };
            return {
                name,
                set(labels = {}, value) {
                    if (!Number.isFinite(value))
                        return;
                    const key = labelKey(labelNames, labels);
                    descriptor.gauges.set(key, { labels: { ...labels }, value });
                },
                inc(labels = {}, value = 1) {
                    if (!Number.isFinite(value))
                        return;
                    const series = current(labels);
                    series.value += value;
                    descriptor.gauges.set(labelKey(labelNames, labels), series);
                },
                dec(labels = {}, value = 1) {
                    if (!Number.isFinite(value))
                        return;
                    const series = current(labels);
                    series.value -= value;
                    descriptor.gauges.set(labelKey(labelNames, labels), series);
                },
            };
        },
        registerGaugeSource(source) {
            assertMetricName(source.name);
            if (source.labelNames)
                assertLabelNames(source.labelNames);
            const duplicate = gaugeSources.find((existing) => existing.name === source.name);
            if (duplicate) {
                const duplicateLabels = (duplicate.labelNames ?? []).join(',');
                const sourceLabels = (source.labelNames ?? []).join(',');
                if (duplicate.help !== source.help || duplicateLabels !== sourceLabels) {
                    throw new Error(`Gauge source ${source.name} already registered with a different definition`);
                }
                return;
            }
            for (const descriptor of definitions.values()) {
                if (renderedNamesCollide(descriptor, { name: source.name, type: GAUGE_SOURCE_TYPE })) {
                    throw new Error(`Gauge source ${source.name} collides with metric ${descriptor.name}`);
                }
            }
            gaugeSources.push(source);
        },
        render() {
            const lines = [];
            const descriptors = [...definitions.values()].sort((a, b) => a.name.localeCompare(b.name));
            for (const descriptor of descriptors) {
                lines.push(`# HELP ${descriptor.name} ${descriptor.help}`);
                lines.push(`# TYPE ${descriptor.name} ${descriptor.type}`);
                if (descriptor.type === 'counter') {
                    for (const series of sortedSeries(descriptor.counters)) {
                        lines.push(`${descriptor.name}${formatLabels(series.labels)} ${formatValue(series.value)}`);
                    }
                }
                else if (descriptor.type === 'gauge') {
                    for (const series of sortedSeries(descriptor.gauges)) {
                        lines.push(`${descriptor.name}${formatLabels(series.labels)} ${formatValue(series.value)}`);
                    }
                }
                else {
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
                let samples = [];
                try {
                    samples = source.collect();
                }
                catch {
                    samples = [];
                }
                if (!Array.isArray(samples))
                    samples = [];
                const rendered = samples
                    .slice(0, exports.MAX_GAUGE_SOURCE_SAMPLES)
                    .filter((sample) => isValidGaugeSample(source, sample))
                    .map((sample) => `${source.name}${formatLabels(sample.labels ?? {})} ${formatValue(sample.value)}`)
                    .sort();
                lines.push(`# HELP ${source.name} ${source.help}`);
                lines.push(`# TYPE ${source.name} gauge`);
                lines.push(...rendered);
            }
            return lines.length > 0 ? `${lines.join('\n')}\n` : '';
        },
    };
}
const sortedSeries = (series) => [...series.values()].sort((a, b) => formatLabels(a.labels).localeCompare(formatLabels(b.labels)));
exports.HTTP_REQUESTS_METRIC = 'http_requests_total';
exports.HTTP_DURATION_METRIC = 'http_request_duration_seconds';
/** The single bucket every unrecognized HTTP verb collapses into. */
exports.HTTP_METHOD_FALLBACK = 'other';
/** Standard HTTP methods that may appear as a `method` label value. */
const BOUNDED_HTTP_METHODS = [
    'GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE',
];
/**
 * Maps an inbound request method to a bounded label value. The label is
 * caller-controlled, so anything outside the standard set (a forged verb, a
 * non-string value, an empty string) collapses into the single
 * `HTTP_METHOD_FALLBACK` bucket: cardinality stays bounded no matter what a
 * client sends.
 */
function boundedHttpMethod(method) {
    if (typeof method !== 'string')
        return exports.HTTP_METHOD_FALLBACK;
    const normalized = method.toUpperCase();
    return BOUNDED_HTTP_METHODS.includes(normalized) ? normalized : exports.HTTP_METHOD_FALLBACK;
}
function createHttpObserver(registry, options = {}) {
    const requests = registry.counter(exports.HTTP_REQUESTS_METRIC, 'Total HTTP requests by method, route template and status class.', ['method', 'route', 'status_class']);
    const duration = registry.histogram(exports.HTTP_DURATION_METRIC, 'HTTP request duration in seconds by method, route template and status class.', ['method', 'route', 'status_class'], options.buckets);
    return {
        observe(observation) {
            const labels = {
                method: boundedHttpMethod(observation.method),
                route: observation.route,
                status_class: (0, exports.statusClass)(observation.status),
            };
            requests.inc(labels);
            duration.observe(labels, Math.max(0, observation.durationMs) / 1000);
        },
    };
}
/** Maps a status code to its class (`2xx`, `4xx`, ...); non-codes are `unknown`. */
const statusClass = (status) => {
    if (!Number.isInteger(status) || status < 100 || status > 599)
        return 'unknown';
    return `${Math.floor(status / 100)}xx`;
};
exports.statusClass = statusClass;
