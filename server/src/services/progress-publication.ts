/**
 * M4 A7/P2 (C4a) — progress report publication state and the parent-facing
 * projection contract.
 *
 * Source of truth for this module is the injected `PublicationStore` ONLY. The
 * SQL schema for the published state (per tenant + student enrollment + course:
 * `draft | published`, `published_by`, `published_at`, `version`) belongs to a
 * separate owner (I2) and is NOT created, migrated or written here. Supplying
 * an injected store in a test is therefore NOT evidence that any SQL has been
 * run or that the schema works; it only exercises the domain decision logic.
 *
 * Domain rules enforced here (deterministic, clock-free apart from the
 * injected `now`):
 *  - Publication state is keyed by (tenant, student enrollment, course). A row
 *    that has never been written is `draft` at version 0.
 *  - `publish`/`unpublish` are version-guarded: the caller supplies the version
 *    it read, and the store applies the transition only when that version still
 *    matches. A lost race returns `conflict` and the store must have performed
 *    no write. The state change and its audit event share one transaction, so
 *    an audit failure rolls the state change back.
 *  - Both transitions are idempotent: publishing an already-published report
 *    and unpublishing an already-draft report succeed without a write and
 *    without a version bump.
 *  - A report's parent projection is deny-by-default: it is `null` while the
 *    report is unpublished and contains only the explicit published-only field
 *    list (no internal enrollment id, no raw exam/assignment averages) once
 *    published. This function only prepares the contract; the parent HTTP
 *    route is NOT part of this task and no raw-grade fallback is offered.
 *
 * The report facts themselves (lesson progress, exam/assignment aggregates)
 * are NOT owned here: they are read through the injected `reportSource` in the
 * route, and this module never queries any gradebook table.
 */

import { projectProgressForParent, ProgressRecord } from './progress-reports';
import type { AuditRecordInput } from '../security/audit';

/** The two stored states of a report scope. */
export type PublicationState = 'draft' | 'published';

/**
 * One published-state row for a (tenant, enrollment, course) scope. A row is
 * `draft` until a teacher publishes it; `published_by`/`published_at` are the
 * actor and instant of the most recent publish (null while draft), and
 * `version` is a monotonic counter bumped by every transition.
 */
export interface PublicationRecord {
    tenantId: string;
    studentEnrollmentId: string;
    courseId: string;
    state: PublicationState;
    publishedBy: string | null;
    publishedAt: Date | null;
    version: number;
}

/** A version-guarded state transition request. */
export interface PublicationTransition {
    tenantId: string;
    studentEnrollmentId: string;
    courseId: string;
    /** The version the caller read; the store applies the write only if it still matches. */
    expectedVersion: number;
    nextState: PublicationState;
    actorUserId: string;
    now: Date;
}

/**
 * The injected publication-state contract. Implementations are the I2 owner's
 * SQL adapter; this module treats it as an opaque boundary. `transitionPublication`
 * returns the number of affected rows (0 means the version no longer matched, so
 * no write happened).
 */
export interface PublicationStore {
    findPublication(tenantId: string, studentEnrollmentId: string, courseId: string): Promise<PublicationRecord | null>;
    listPublications(tenantId: string, courseId?: string): Promise<PublicationRecord[]>;
    transitionPublication(input: PublicationTransition): Promise<number>;
}

/** Audit writer seam; production binds `recordAudit` to the transaction executor. */
export type AuditWriter = (input: AuditRecordInput) => Promise<void>;

export interface PublicationTransactionContext {
    store: PublicationStore;
    audit: AuditWriter;
}

/** Same-transaction seam: the state change and its audit event commit together. */
export type PublicationTransaction = <T>(fn: (ctx: PublicationTransactionContext) => Promise<T>) => Promise<T>;

export interface PublicationCommand {
    tenantId: string;
    studentEnrollmentId: string;
    courseId: string;
    actorUserId: string;
}

export type PublicationOutcome =
    | { kind: 'published'; record: PublicationRecord }
    | { kind: 'already-published'; record: PublicationRecord }
    | { kind: 'unpublished'; record: PublicationRecord }
    | { kind: 'already-draft'; record: PublicationRecord }
    | { kind: 'conflict' };

export interface ProgressPublicationService {
    publish(command: PublicationCommand): Promise<PublicationOutcome>;
    unpublish(command: PublicationCommand): Promise<PublicationOutcome>;
    getState(query: { tenantId: string; studentEnrollmentId: string; courseId: string }): Promise<PublicationRecord>;
    listState(tenantId: string, courseId?: string): Promise<PublicationRecord[]>;
}

export interface ProgressPublicationServiceDeps {
    store: PublicationStore;
    audit: AuditWriter;
    now?: () => Date;
    /**
     * Required same-transaction seam. There is deliberately no autocommit
     * fallback: a state transition and its audit event must commit together, so
     * an incomplete configuration is rejected before any write.
     */
    transaction: PublicationTransaction;
}

/**
 * Runtime guard for untyped/JS callers. TypeScript already requires the seam,
 * but the service also fails closed at construction when the injected wiring is
 * incomplete so that no mutation can run on a partial configuration.
 */
const assertCompleteDeps = (deps: ProgressPublicationServiceDeps): void => {
    const store = deps?.store;
    if (
        !store
        || typeof store.findPublication !== 'function'
        || typeof store.listPublications !== 'function'
        || typeof store.transitionPublication !== 'function'
        || typeof deps.audit !== 'function'
        || typeof deps.transaction !== 'function'
    ) {
        throw new Error('ProgressPublicationService requires store, audit and transaction');
    }
};

const draftPublication = (tenantId: string, studentEnrollmentId: string, courseId: string): PublicationRecord => ({
    tenantId,
    studentEnrollmentId,
    courseId,
    state: 'draft',
    publishedBy: null,
    publishedAt: null,
    version: 0,
});

/** The report key a caller binds a publication row to (never inferred from the row). */
export interface ProgressReportIdentity {
    tenantId: string;
    studentEnrollmentId: string;
    courseId: string;
}

/**
 * Project a progress record for a linked parent. Deny-by-default: returns
 * `null` while the report is unpublished, and otherwise delegates to the
 * existing `projectProgressForParent` semantics, which exposes only the
 * explicit published-only field list (course id/name, lesson counts, overall,
 * status) and never the internal enrollment id or raw exam/assignment
 * averages. This prepares the parent contract; it is not an HTTP route.
 *
 * A bare state marker is NOT publication proof. The trusted caller MUST pass
 * the `PublicationRecord` it read and the report identity it is serving (from
 * the parent link, never from the row being projected). The row is accepted
 * only when tenant, enrollment and course all match the identity AND the record
 * being projected; a missing identity, a scalar marker (guarded at runtime for
 * untyped callers), a non-published row or any mismatch returns `null`.
 */
export function parentProjection(
    record: ProgressRecord,
    state: PublicationRecord | null,
    identity?: ProgressReportIdentity,
): Record<string, unknown> | null {
    if (state === null || typeof state !== 'object') return null;
    if (state.state !== 'published' || !identity) return null;
    if (
        state.tenantId !== identity.tenantId
        || state.studentEnrollmentId !== identity.studentEnrollmentId
        || state.courseId !== identity.courseId
        || record.studentEnrollmentId !== identity.studentEnrollmentId
        || record.courseId !== identity.courseId
    ) {
        return null;
    }
    return projectProgressForParent({ ...record, published: true });
}

export const createProgressPublicationService = (deps: ProgressPublicationServiceDeps): ProgressPublicationService => {
    assertCompleteDeps(deps);
    const now = deps.now ?? (() => new Date());
    const runAtomic = deps.transaction;

    const transition = async (
        command: PublicationCommand,
        nextState: PublicationState,
        action: string,
    ): Promise<PublicationOutcome> => {
        const at = now();
        return runAtomic(async ({ store, audit }) => {
            const current = await store.findPublication(command.tenantId, command.studentEnrollmentId, command.courseId);
            if (nextState === 'published' && current?.state === 'published') {
                return { kind: 'already-published', record: current };
            }
            if (nextState === 'draft' && (current === null || current.state === 'draft')) {
                return {
                    kind: 'already-draft',
                    record: current ?? draftPublication(command.tenantId, command.studentEnrollmentId, command.courseId),
                };
            }
            const expectedVersion = current?.version ?? 0;
            const affected = await store.transitionPublication({
                tenantId: command.tenantId,
                studentEnrollmentId: command.studentEnrollmentId,
                courseId: command.courseId,
                expectedVersion,
                nextState,
                actorUserId: command.actorUserId,
                now: at,
            });
            if (affected === 0) return { kind: 'conflict' };
            const record: PublicationRecord = {
                tenantId: command.tenantId,
                studentEnrollmentId: command.studentEnrollmentId,
                courseId: command.courseId,
                state: nextState,
                publishedBy: nextState === 'published' ? command.actorUserId : null,
                publishedAt: nextState === 'published' ? at : null,
                version: expectedVersion + 1,
            };
            await audit({
                actorUserId: command.actorUserId,
                tenantId: command.tenantId,
                action,
                resourceType: 'progress_report',
                resourceId: `${command.studentEnrollmentId}:${command.courseId}`,
                oldValue: current ? { state: current.state, version: current.version } : null,
                newValue: { state: record.state, version: record.version },
            });
            return { kind: nextState === 'published' ? 'published' : 'unpublished', record };
        });
    };

    return {
        publish: (command) => transition(command, 'published', 'progress_report.publish'),
        unpublish: (command) => transition(command, 'draft', 'progress_report.unpublish'),
        getState: async (query) => {
            const found = await deps.store.findPublication(query.tenantId, query.studentEnrollmentId, query.courseId);
            return found ?? draftPublication(query.tenantId, query.studentEnrollmentId, query.courseId);
        },
        listState: (tenantId, courseId) => deps.store.listPublications(tenantId, courseId),
    };
};
