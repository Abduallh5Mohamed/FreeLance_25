"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_WORKER_RUN_BUCKETS = exports.WORKER_BACKLOG_METRIC = exports.WORKER_TELEMETRY_INCIDENTS_METRIC = exports.WORKER_LAST_SUCCESS_METRIC = exports.WORKER_RUNNING_METRIC = exports.WORKER_PASSES_INFLIGHT_METRIC = exports.WORKER_RUN_DURATION_METRIC = exports.WORKER_RUNS_METRIC = exports.WORKER_TELEMETRY_INCIDENT_REASONS = exports.WORKER_OUTCOMES = exports.WORKER_KINDS = void 0;
exports.createWorkerObservability = createWorkerObservability;
exports.WORKER_KINDS = [
    'notification',
    'assignment_scan',
    'tenant_export',
    'media_reconciliation',
];
exports.WORKER_OUTCOMES = [
    'succeeded',
    'failed',
    'unknown',
    'skipped',
];
exports.WORKER_TELEMETRY_INCIDENT_REASONS = [
    'invalid_worker_kind',
    'invalid_outcome',
    'invalid_duration',
    'duplicate_end',
    'observer_error',
];
exports.WORKER_RUNS_METRIC = 'worker_runs_total';
exports.WORKER_RUN_DURATION_METRIC = 'worker_run_duration_seconds';
exports.WORKER_PASSES_INFLIGHT_METRIC = 'worker_passes_inflight';
exports.WORKER_RUNNING_METRIC = 'worker_running';
exports.WORKER_LAST_SUCCESS_METRIC = 'worker_last_success_timestamp_seconds';
exports.WORKER_TELEMETRY_INCIDENTS_METRIC = 'worker_telemetry_incidents_total';
exports.WORKER_BACKLOG_METRIC = 'worker_backlog';
exports.DEFAULT_WORKER_RUN_BUCKETS = [
    0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900, 3600,
];
function createWorkerObservability(registry, options = {}) {
    if (typeof registry !== 'object' || registry === null || typeof registry.render !== 'function') {
        throw new Error('createWorkerObservability requires an existing MetricsRegistry');
    }
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const incidentCounter = registry.counter(exports.WORKER_TELEMETRY_INCIDENTS_METRIC, 'Rejected or duplicated observer observations, by bounded reason.', ['reason']);
    const runsCounter = registry.counter(exports.WORKER_RUNS_METRIC, 'Completed worker runs by kind and declared outcome.', ['kind', 'outcome']);
    const durationHistogram = registry.histogram(exports.WORKER_RUN_DURATION_METRIC, 'Worker run duration in seconds by kind.', ['kind'], options.runDurationBuckets);
    const inflightGauge = registry.gauge(exports.WORKER_PASSES_INFLIGHT_METRIC, 'Worker operations currently in flight by kind.', ['kind']);
    const runningGauge = registry.gauge(exports.WORKER_RUNNING_METRIC, 'Worker lifecycle running flag (1/0) by kind; unset means unknown.', ['kind']);
    const lastSuccessGauge = registry.gauge(exports.WORKER_LAST_SUCCESS_METRIC, 'Epoch seconds of the last run that ended with outcome succeeded, by kind; unset means never.', ['kind']);
    const KIND_LABELS = {
        notification: { kind: 'notification' },
        assignment_scan: { kind: 'assignment_scan' },
        tenant_export: { kind: 'tenant_export' },
        media_reconciliation: { kind: 'media_reconciliation' },
    };
    const kindValue = (kind) => typeof kind === 'string' && exports.WORKER_KINDS.includes(kind)
        ? kind
        : null;
    const outcomeValue = (outcome) => typeof outcome === 'string' && exports.WORKER_OUTCOMES.includes(outcome)
        ? outcome
        : null;
    const durationValue = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const recordIncident = (reason) => {
        try {
            incidentCounter.inc({ reason });
        }
        catch {
            return undefined;
        }
    };
    const guarded = (operation) => {
        try {
            operation();
        }
        catch {
            recordIncident('observer_error');
        }
    };
    const safeNow = () => {
        try {
            const value = now();
            return typeof value === 'number' && Number.isFinite(value) ? value : null;
        }
        catch {
            return null;
        }
    };
    const recordEnd = (labels, outcomeInput, durationMs, explicitDurationProvided, explicitDurationInvalid) => {
        if (explicitDurationProvided && explicitDurationInvalid)
            recordIncident('invalid_duration');
        guarded(() => inflightGauge.dec(labels));
        if (durationMs !== null) {
            guarded(() => durationHistogram.observe(labels, durationMs / 1000));
        }
        const outcome = outcomeValue(outcomeInput);
        if (outcome === null) {
            recordIncident('invalid_outcome');
            return;
        }
        guarded(() => runsCounter.inc({ ...labels, outcome }));
        if (outcome === 'succeeded') {
            const epochSeconds = safeNow();
            if (epochSeconds !== null) {
                guarded(() => lastSuccessGauge.set(labels, Math.floor(epochSeconds / 1000)));
            }
        }
    };
    const startWorkerRun = (kindInput) => {
        const kind = kindValue(kindInput);
        if (kind === null) {
            recordIncident('invalid_worker_kind');
            return {
                end() {
                    recordIncident('invalid_worker_kind');
                },
            };
        }
        const labels = KIND_LABELS[kind];
        const startedAt = safeNow();
        guarded(() => inflightGauge.inc(labels));
        let ended = false;
        return {
            end(outcomeInput, observation) {
                if (ended) {
                    recordIncident('duplicate_end');
                    return;
                }
                ended = true;
                let explicitDurationInvalid = false;
                let explicitDurationProvided = false;
                let durationMs = null;
                if (startedAt !== null) {
                    const finishedAt = safeNow();
                    durationMs = finishedAt === null ? null : Math.max(0, finishedAt - startedAt);
                }
                if (observation !== undefined && observation !== null && observation.durationMs !== undefined) {
                    explicitDurationProvided = true;
                    const explicit = durationValue(observation.durationMs);
                    if (explicit === null) {
                        explicitDurationInvalid = true;
                    }
                    else {
                        durationMs = explicit;
                    }
                }
                recordEnd(labels, outcomeInput, durationMs, explicitDurationProvided, explicitDurationInvalid);
            },
        };
    };
    const runWorkerOperation = (kind, operation, classify) => {
        const handle = startWorkerRun(kind);
        return Promise.resolve()
            .then(operation)
            .then((result) => {
            let outcomeInput = 'succeeded';
            if (typeof classify === 'function') {
                try {
                    outcomeInput = classify(result);
                }
                catch {
                    outcomeInput = undefined;
                }
            }
            handle.end(outcomeInput);
            return result;
        })
            .catch((error) => {
            handle.end('failed');
            throw error;
        });
    };
    const setWorkerRunning = (kindInput, running) => {
        const kind = kindValue(kindInput);
        if (kind === null) {
            recordIncident('invalid_worker_kind');
            return;
        }
        guarded(() => runningGauge.set(KIND_LABELS[kind], running === true ? 1 : 0));
    };
    const samplers = options.backlogSamplers ?? {};
    const backlogKinds = exports.WORKER_KINDS.filter((kind) => typeof samplers[kind] === 'function');
    if (backlogKinds.length > 0) {
        const backlogSource = {
            name: exports.WORKER_BACKLOG_METRIC,
            help: 'Runnable backlog depth per worker kind, sampled at scrape time by the domain owner; a missing series means unknown, never zero.',
            labelNames: ['kind'],
            collect() {
                const samples = [];
                const configured = samplers;
                for (const kind of backlogKinds) {
                    try {
                        const value = configured[kind]();
                        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
                            samples.push({ labels: { kind }, value: value });
                        }
                    }
                    catch {
                        continue;
                    }
                }
                return samples;
            },
        };
        registry.registerGaugeSource(backlogSource);
    }
    return {
        startWorkerRun,
        runWorkerOperation,
        setWorkerRunning,
    };
}
