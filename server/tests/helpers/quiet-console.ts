/**
 * Test-only console silencer.
 *
 * Many boundary suites deliberately drive the REAL routes into simulated
 * failures (DB outages, MinIO errors, denied lookups) and the production code
 * logs those expected failures via console.error/console.log. Under the node
 * test runner every console write inside a test is captured, serialized and
 * shipped over the worker's IPC channel. Large bursts of that expected noise
 * intermittently overrun the channel and surface as:
 *
 *   failureType: 'uncaughtException'
 *   'Unable to deserialize cloned data due to invalid or unsupported version'
 *
 * Silencing the EXPECTED output at its source keeps the IPC channel small.
 * Only the console methods are replaced; assertions, the runner's own TAP
 * reporting and any captured-by-the-test behaviour are untouched.
 *
 * Typical usage (hooks make it per-test and self-restoring):
 *
 *   import { quietConsole, restoreConsole } from './helpers/quiet-console';
 *   test.beforeEach(quietConsole);
 *   test.afterEach(restoreConsole);
 */

type ConsoleMethod = (...args: unknown[]) => void;

interface ConsoleSnapshot {
    log: ConsoleMethod;
    error: ConsoleMethod;
    warn: ConsoleMethod;
    info: ConsoleMethod;
}

const NOOP: ConsoleMethod = () => undefined;

let depth = 0;
let snapshot: ConsoleSnapshot | null = null;

/**
 * Replace console.log/error/warn/info with no-ops. Nesting-safe: the original
 * methods are captured only on the outermost entry and restored by the
 * matching restoreConsole().
 */
export const quietConsole = (): void => {
    if (depth === 0) {
        snapshot = {
            log: console.log,
            error: console.error,
            warn: console.warn,
            info: console.info,
        };
        console.log = NOOP;
        console.error = NOOP;
        console.warn = NOOP;
        console.info = NOOP;
    }
    depth += 1;
};

/** Undo one quietConsole() call, restoring the console on the outermost exit. */
export const restoreConsole = (): void => {
    if (depth === 0) return;
    depth -= 1;
    if (depth === 0 && snapshot) {
        console.log = snapshot.log;
        console.error = snapshot.error;
        console.warn = snapshot.warn;
        console.info = snapshot.info;
        snapshot = null;
    }
};

/** Run `fn` with console output silenced and always restored afterwards. */
export const withQuietConsole = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    quietConsole();
    try {
        return await fn();
    } finally {
        restoreConsole();
    }
};
