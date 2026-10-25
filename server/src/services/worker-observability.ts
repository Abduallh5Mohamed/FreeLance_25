import type {
    GaugeSample,
    GaugeSource,
    Labels,
    MetricsRegistry,
} from './metrics';

export const WORKER_KINDS = [
    'notification',
    'assignment_scan',
    'tenant_export',
    'media_reconciliation',
] as const;

export type WorkerKind = (typeof WORKER_KINDS)[number];

export const WORKER_OUTCOMES = [
    'succeeded',
    'failed',
    'unknown',
    'skipped',
] as const;

export type WorkerOutcome = (typeof WORKER_OUTCOMES)[number];

export const WORKER_TELEMETRY_INCIDENT_REASONS = [
    'invalid_worker_kind',
    'invalid_outcome',
    'invalid_duration',
    'duplicate_end',
    'observer_error',
] as const;

export type WorkerTelemetryIncidentReason = (typeof WORKER_TELEMETRY_INCIDENT_REASONS)[number];

export const WORKER_RUNS_METRIC = 'worker_runs_total';
export const WORKER_RUN_DURATION_METRIC = 'worker_run_duration_seconds';
export const WORKER_PASSES_INFLIGHT_METRIC = 'worker_passes_inflight';
export const WORKER_RUNNING_METRIC = 'worker_running';
export const WORKER_LAST_SUCCESS_METRIC = 'worker_last_success_timestamp_seconds';
export const WORKER_TELEMETRY_INCIDENTS_METRIC = 'worker_telemetry_incidents_total';
export const WORKER_BACKLOG_METRIC = 'worker_backlog';

export const DEFAULT_WORKER_RUN_BUCKETS: readonly number[] = [
    0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900, 3600,
];

export interface WorkerRunObservation {
    durationMs?: number;
}

export interface WorkerRunHandle {
    end(outcome: WorkerOutcome, observation?: WorkerRunObservation): void;
}

export interface WorkerBacklogSampler {
    (): number | null;
}

export interface WorkerObservabilityOptions {
    now?: () => number;
    runDurationBuckets?: readonly number[];
    backlogSamplers?: Partial<Record<WorkerKind, WorkerBacklogSampler>>;
}

export interface WorkerObservability {
    startWorkerRun(kind: WorkerKind): WorkerRunHandle;
    runWorkerOperation<T>(
        kind: WorkerKind,
        operation: () => T | Promise<T>,
        classify?: (result: T) => WorkerOutcome,
    ): Promise<T>;
    setWorkerRunning(kind: WorkerKind, running: boolean): void;
}

export function createWorkerObservability(
    registry: MetricsRegistry,
    options: WorkerObservabilityOptions = {},
): WorkerObservability {
    if (typeof registry !== 'object' || registry === null || typeof registry.render !== 'function') {
        throw new Error('createWorkerObservability requires an existing MetricsRegistry');
    }
    const now = typeof options.now === 'function' ? options.now : (): number => Date.now();

    const incidentCounter = registry.counter(
        WORKER_TELEMETRY_INCIDENTS_METRIC,
        'Rejected or duplicated observer observations, by bounded reason.',
        ['reason'],
    );
    const runsCounter = registry.counter(
        WORKER_RUNS_METRIC,
        'Completed worker runs by kind and declared outcome.',
        ['kind', 'outcome'],
    );
    const durationHistogram = registry.histogram(
        WORKER_RUN_DURATION_METRIC,
        'Worker run duration in seconds by kind.',
        ['kind'],
        options.runDurationBuckets,
    );
    const inflightGauge = registry.gauge(
        WORKER_PASSES_INFLIGHT_METRIC,
        'Worker operations currently in flight by kind.',
        ['kind'],
    );
    const runningGauge = registry.gauge(
        WORKER_RUNNING_METRIC,
        'Worker lifecycle running flag (1/0) by kind; unset means unknown.',
        ['kind'],
    );
    const lastSuccessGauge = registry.gauge(
        WORKER_LAST_SUCCESS_METRIC,
        'Epoch seconds of the last run that ended with outcome succeeded, by kind; unset means never.',
        ['kind'],
    );

    const KIND_LABELS: Record<WorkerKind, Labels> = {
        notification: { kind: 'notification' },
        assignment_scan: { kind: 'assignment_scan' },
        tenant_export: { kind: 'tenant_export' },
        media_reconciliation: { kind: 'media_reconciliation' },
    };

    const kindValue = (kind: unknown): WorkerKind | null =>
        typeof kind === 'string' && (WORKER_KINDS as readonly string[]).includes(kind)
            ? (kind as WorkerKind)
            : null;

    const outcomeValue = (outcome: unknown): WorkerOutcome | null =>
        typeof outcome === 'string' && (WORKER_OUTCOMES as readonly string[]).includes(outcome)
            ? (outcome as WorkerOutcome)
            : null;

    const durationValue = (value: unknown): number | null =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

    const recordIncident = (reason: WorkerTelemetryIncidentReason): void => {
        try {
            incidentCounter.inc({ reason });
        } catch {
            return undefined;
        }
    };

    const guarded = (operation: () => void): void => {
        try {
            operation();
        } catch {
            recordIncident('observer_error');
        }
    };

    const safeNow = (): number | null => {
        try {
            const value = now();
            return typeof value === 'number' && Number.isFinite(value) ? value : null;
        } catch {
            return null;
        }
    };

    const recordEnd = (
        labels: Labels,
        outcomeInput: unknown,
        durationMs: number | null,
        explicitDurationProvided: boolean,
        explicitDurationInvalid: boolean,
    ): void => {
        if (explicitDurationProvided && explicitDurationInvalid) recordIncident('invalid_duration');
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

    const startWorkerRun = (kindInput: WorkerKind): WorkerRunHandle => {
        const kind = kindValue(kindInput);
        if (kind === null) {
            recordIncident('invalid_worker_kind');
            return {
                end(): void {
                    recordIncident('invalid_worker_kind');
                },
            };
        }
        const labels = KIND_LABELS[kind];
        const startedAt = safeNow();
        guarded(() => inflightGauge.inc(labels));
        let ended = false;
        return {
            end(outcomeInput: WorkerOutcome, observation?: WorkerRunObservation): void {
                if (ended) {
                    recordIncident('duplicate_end');
                    return;
                }
                ended = true;
                let explicitDurationInvalid = false;
                let explicitDurationProvided = false;
                let durationMs: number | null = null;
                if (startedAt !== null) {
                    const finishedAt = safeNow();
                    durationMs = finishedAt === null ? null : Math.max(0, finishedAt - startedAt);
                }
                if (observation !== undefined && observation !== null && observation.durationMs !== undefined) {
                    explicitDurationProvided = true;
                    const explicit = durationValue(observation.durationMs);
                    if (explicit === null) {
                        explicitDurationInvalid = true;
                    } else {
                        durationMs = explicit;
                    }
                }
                recordEnd(labels, outcomeInput, durationMs, explicitDurationProvided, explicitDurationInvalid);
            },
        };
    };

    const runWorkerOperation = <T>(
        kind: WorkerKind,
        operation: () => T | Promise<T>,
        classify?: (result: T) => WorkerOutcome,
    ): Promise<T> => {
        const handle = startWorkerRun(kind);
        return Promise.resolve()
            .then(operation)
            .then((result: T) => {
                let outcomeInput: unknown = 'succeeded';
                if (typeof classify === 'function') {
                    try {
                        outcomeInput = classify(result);
                    } catch {
                        outcomeInput = undefined;
                    }
                }
                handle.end(outcomeInput as WorkerOutcome);
                return result;
            })
            .catch((error: unknown) => {
                handle.end('failed');
                throw error;
            });
    };

    const setWorkerRunning = (kindInput: WorkerKind, running: boolean): void => {
        const kind = kindValue(kindInput);
        if (kind === null) {
            recordIncident('invalid_worker_kind');
            return;
        }
        guarded(() => runningGauge.set(KIND_LABELS[kind], running === true ? 1 : 0));
    };

    const samplers = options.backlogSamplers ?? {};
    const backlogKinds = WORKER_KINDS.filter((kind) => typeof samplers[kind] === 'function');
    if (backlogKinds.length > 0) {
        const backlogSource: GaugeSource = {
            name: WORKER_BACKLOG_METRIC,
            help: 'Runnable backlog depth per worker kind, sampled at scrape time by the domain owner; a missing series means unknown, never zero.',
            labelNames: ['kind'],
            collect(): GaugeSample[] {
                const samples: GaugeSample[] = [];
                const configured = samplers as Record<WorkerKind, WorkerBacklogSampler>;
                for (const kind of backlogKinds) {
                    try {
                        const value = configured[kind]();
                        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
                            samples.push({ labels: { kind }, value: value });
                        }
                    } catch {
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
