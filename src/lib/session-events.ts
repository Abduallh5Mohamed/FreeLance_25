/**
 * Same-document reactive session/identity/scope notification contract.
 *
 * Human-approved M1 contract closure (supervisor/026, task
 * client-m1-contract-session-20261016-01): token/identity/scope mutations
 * complete in one document (login, logout, token rotation, identity or
 * student-space switch, server-side revocation) and every subscriber that
 * cached the old session must react in the SAME document — before a stale
 * response can commit — instead of waiting for a reload or a cross-tab
 * storage event.
 *
 * Design rules (from the approved task):
 *  - the event detail carries NO token, user, private-link or any other
 *    secret data — only the kind of change. Consumers re-read the canonical
 *    storage themselves;
 *  - notification happens only AFTER the complete session mutation (the
 *    canonical writers in api-http.ts notify last);
 *  - no localStorage/global monkeypatching, no polling: this is a plain
 *    in-process listener set. Cross-tab protection stays on the existing
 *    storage listeners;
 *  - subscribers unsubscribe on unmount, so a retired view never reacts.
 *
 * No env, no network, no DOM, no storage: safe to import from pages,
 * components, hooks and node:test suites alike.
 */

/**
 * Kinds of session change. `login`/`token` cover credential establishment
 * and rotation; `identity` covers a stored identity/profile rewrite (e.g.
 * billing_only or a student-space switch); `logout` covers credential
 * clearing and revocation; `scope` covers a workspace/tenant selection
 * change.
 */
export type SessionChangeKind = 'login' | 'token' | 'identity' | 'logout' | 'scope';

/** The notification payload: the kind, and nothing else (no secrets). */
export interface SessionChangeEvent {
    readonly kind: SessionChangeKind;
}

export type SessionChangeListener = (event: SessionChangeEvent) => void;

const listeners = new Set<SessionChangeListener>();

/**
 * Subscribe to session changes. Returns the unsubscribe function; a
 * subscriber that unmounts MUST call it, and a listener must never throw
 * into the notifier (each listener is invoked independently).
 */
export const subscribeSessionChange = (listener: SessionChangeListener): (() => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

/**
 * Notify every current subscriber of a completed session mutation. Called
 * only by the canonical writers, only after the whole mutation committed.
 * A throwing listener can never break the mutation that just completed.
 */
export const notifySessionChange = (kind: SessionChangeKind): void => {
    if (listeners.size === 0) return;
    const event: SessionChangeEvent = { kind };
    for (const listener of [...listeners]) {
        try {
            listener(event);
        } catch {
            // A broken subscriber must not break the session mutation that
            // already completed, nor the other subscribers.
        }
    }
};
