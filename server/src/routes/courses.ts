import { Router, Response } from 'express';
import { randomUUID } from 'crypto';
import type { PoolConnection } from 'mysql2/promise';
import { query, queryOne, execute, getPool } from '../db';
import { AuthRequest, optionalAuth } from '../middleware/auth';
import { requireTeachingWrite } from '../middleware/teaching-access';

const router = Router();
router.use(optionalAuth);

// Get all courses
const courseScope = (req: AuthRequest): { clause: string; params: string[] } => {
    if (req.user?.tenantId) return { clause: ' AND tenant_id=?', params: [req.user.tenantId] };
    if (req.user?.role === 'admin') return { clause: '', params: [] };
    return { clause: ' AND tenant_id IS NULL', params: [] };
};

// Get courses visible inside the current caller's teaching space.
router.get('/', async (req: AuthRequest, res: Response) => {
    try {
        const scope = courseScope(req);
        const courses = await query(
            `SELECT * FROM courses WHERE is_active=TRUE${scope.clause} ORDER BY name`, scope.params
        );
        res.json(courses);
    } catch (error) {
        console.error('Get courses error:', error);
        res.status(500).json({ error: 'Failed to fetch courses' });
    }
});

// Get course by ID
router.get('/:id', async (req: AuthRequest, res: Response) => {
    try {
        const scope = courseScope(req);
        const course = await queryOne(
            `SELECT * FROM courses WHERE id=? AND is_active=TRUE${scope.clause}`,
            [req.params.id, ...scope.params]
        );

        if (!course) {
            return res.status(404).json({ error: 'Course not found' });
        }

        res.json(course);
    } catch (error) {
        console.error('Get course error:', error);
        res.status(500).json({ error: 'Failed to fetch course' });
    }
});

// Create new course
router.post('/', requireTeachingWrite('courses'), async (req: AuthRequest, res: Response) => {
    try {
        const { name, subject, description, grade, price = 0 } = req.body;
        const normalizedName = String(name || '').trim();
        const normalizedSubject = String(subject || '').trim();

        if (!normalizedName || normalizedName.length > 255 || normalizedSubject.length > 100) {
            return res.status(400).json({ error: 'Course name is required' });
        }

        let tenantId: string | null = null;
        let instructorId: string | null = null;
        if (req.user?.tenantId && ['instructor', 'teacher', 'staff'].includes(req.user.role)) {
            tenantId = req.user.tenantId;
            instructorId = req.user.id;
        } else {
            return res.status(403).json({ error: 'An active tenant membership is required' });
        }

        // Generate UUID for the new course
        const idResult = await query<{id: string}>('SELECT UUID() as id');
        const newId = idResult[0].id;

        await execute(
            `INSERT INTO courses (id,tenant_id,instructor_id,name,subject,description,grade,price)
             VALUES (?,?,?,?,?,?,?,?)`,
            [newId, tenantId, instructorId, normalizedName, normalizedSubject || null, description || null, grade || null, price]
        );

        const newCourse = await queryOne(
            'SELECT * FROM courses WHERE id = ?',
            [newId]
        );

        res.status(201).json(newCourse);
    } catch (error) {
        console.error('Create course error:', error);
        res.status(500).json({ error: 'Failed to create course' });
    }
});

// Update course
router.put('/:id', requireTeachingWrite('courses'), async (req: AuthRequest, res: Response) => {
    try {
        const { name, subject, description, grade, price } = req.body;
        const { id } = req.params;
        const normalizedName = String(name || '').trim();
        const normalizedSubject = String(subject || '').trim();
        if (!normalizedName || normalizedName.length > 255 || normalizedSubject.length > 100) {
            return res.status(400).json({ error: 'Valid course name and subject are required' });
        }

        const scope = courseScope(req);
        const result = await execute(
            `UPDATE courses SET name=?,subject=?,description=?,grade=?,price=? WHERE id=?${scope.clause}`,
            [normalizedName, normalizedSubject || null, description || null, grade || null, price || 0, id, ...scope.params]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Course not found in your workspace' });

        const updatedCourse = await queryOne(
            'SELECT * FROM courses WHERE id = ?',
            [id]
        );

        res.json(updatedCourse);
    } catch (error) {
        console.error('Update course error:', error);
        res.status(500).json({ error: 'Failed to update course' });
    }
});

// Delete course
router.delete('/:id', requireTeachingWrite('courses'), async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;

        const scope = courseScope(req);
        const result = await execute(
            `UPDATE courses SET is_active=FALSE WHERE id=?${scope.clause}`,
            [id, ...scope.params]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Course not found in your workspace' });

        res.json({ message: 'Course deleted successfully' });
    } catch (error) {
        console.error('Delete course error:', error);
        res.status(500).json({ error: 'Failed to delete course' });
    }
});

// ---------------------------------------------------------------------------
// M2-22 — explicit course publication (private, audited, transactional)
//
// An explicit publish/unpublish for ONE active course of the server-selected
// tenant. The five legacy handlers above are deliberately UNTOUCHED: they keep
// their mounts, their scope and their response shapes, and none of them reads
// or writes `publication_state`. In particular the legacy `PUT /:id` cannot
// change publication, because it only writes name/subject/description/grade/
// price — publication has exactly ONE write path, the route below.
//
// Publication is a DISCOVERY flag and nothing else. It enrolls no student,
// grants no content access, exposes no lesson, unit, file or material, charges
// no price, creates no account and sends nothing. It also is not derived from
// `is_active`: archiving a published course withdraws it from public discovery
// (the public read requires BOTH) without rewriting its publication record.
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The only two states a client may ask for. `unpublished` is not a state. */
const WRITABLE_PUBLICATION_STATES: ReadonlySet<string> = new Set(['draft', 'published']);

const PUBLICATION_ALLOWED_KEYS: ReadonlySet<string> = new Set(['publication_state']);

/** Authority revalidation on the same connection, inside the transaction. */
const MEMBER_LOCK_SELECT =
    'SELECT m.role_key,u.is_active AS caller_active,t.status AS tenant_status ' +
    'FROM tenant_memberships m JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id ' +
    "WHERE m.user_id=? AND m.tenant_id=? AND m.status='active' LIMIT 1 FOR UPDATE";

/**
 * Locks the target course inside the selected tenant.
 *
 * `is_active=TRUE` is part of the lock, so an ARCHIVED course is one 404 for
 * publication — it is already absent from the management surface and from
 * public discovery, so there is no publication transition to make on it.
 *
 * The tenant qualification is the same one the accepted legacy `PUT`/`DELETE`
 * use (`courses.tenant_id = <selected tenant>`), so publication authority is
 * exactly as wide as the course-edit authority that already exists: any active
 * teaching member of the selected tenant, never a cross-tenant caller. No
 * instructor-level narrowing is invented here, because the accepted course
 * write path does not have one either.
 *
 * `published_at` is projected as an EPOCH, never as a driver datetime: the pool
 * is configured with `timezone: '+02:00'`, so a raw TIMESTAMP value would be
 * re-interpreted on the client side and every serialized instant would shift.
 */
const COURSE_LOCK_SELECT =
    'SELECT c.id,c.name,c.publication_state,UNIX_TIMESTAMP(c.published_at) AS published_at_epoch ' +
    'FROM courses c WHERE c.id=? AND c.tenant_id=? AND c.is_active=TRUE FOR UPDATE';

const COURSE_PUBLISH_SQL =
    "UPDATE courses SET publication_state='published'," +
    'published_at=COALESCE(published_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP ' +
    'WHERE id=? AND tenant_id=? AND is_active=TRUE';

const COURSE_UNPUBLISH_SQL =
    "UPDATE courses SET publication_state='draft',published_at=NULL,updated_at=CURRENT_TIMESTAMP " +
    'WHERE id=? AND tenant_id=? AND is_active=TRUE';

const COURSE_PUBLICATION_READ_SQL =
    'SELECT c.id,c.name,c.publication_state,UNIX_TIMESTAMP(c.published_at) AS published_at_epoch ' +
    'FROM courses c WHERE c.id=? AND c.tenant_id=? AND c.is_active=TRUE LIMIT 1';

const AUDIT_SQL =
    'INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value) VALUES (?,?,?,?,?,?,?,?)';

interface MembershipRow { role_key: string; caller_active: number | boolean; tenant_status: string }

const isTeachingMember = (row: MembershipRow | undefined): boolean =>
    !!row &&
    (row.role_key === 'owner' || row.role_key === 'instructor') &&
    Number(row.caller_active) === 1 &&
    row.tenant_status === 'active';

/** Epoch seconds -> UTC ISO-8601, or `null`. Never a wall-time guess. */
const publicationStamp = (epoch: unknown): string | null => {
    if (epoch === null || epoch === undefined) return null;
    const seconds = Number(epoch);
    if (!Number.isFinite(seconds)) return null;
    return new Date(seconds * 1000).toISOString();
};

/**
 * The fixed THREE-field publication projection. `tenant_id`, `instructor_id`,
 * price, counters and every other column stay server-side and are never
 * spread into a response.
 */
const publicationDto = (row: any) => ({
    course_id: String(row.id),
    publication_state: String(row.publication_state),
    published_at: publicationStamp(row.published_at_epoch),
});

type PublicationParse =
    | { ok: true; state: 'draft' | 'published' }
    | { ok: false; error: string };

/**
 * Strict canonical payload: EXACTLY `{ publication_state }`, whose value is
 * `draft` or `published`.
 *
 * Nothing else is accepted — no `tenant_id`, no `instructor_id`, no `is_active`,
 * no `published_at`, no price. A caller therefore cannot back-date a
 * publication, cannot publish another tenant's course by naming a tenant, and
 * cannot smuggle an unrelated course column through this route.
 */
function parsePublicationBody(body: unknown): PublicationParse {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { ok: false, error: 'Invalid publication payload' };
    }
    const obj = body as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
        if (!PUBLICATION_ALLOWED_KEYS.has(key)) {
            return { ok: false, error: 'Invalid publication payload' };
        }
    }
    if (!('publication_state' in obj)) {
        return { ok: false, error: 'Invalid publication payload' };
    }
    const state = obj.publication_state;
    if (typeof state !== 'string' || !WRITABLE_PUBLICATION_STATES.has(state)) {
        return { ok: false, error: 'Invalid publication state' };
    }
    return { ok: true, state: state as 'draft' | 'published' };
}

/**
 * `PUT /api/courses/:id/publication`
 *
 * Body: exactly `{ "publication_state": "draft" | "published" }`.
 *
 * Publishes or withdraws ONE active course of the server-selected tenant:
 *  - authority (active membership, active user, active tenant, teaching role)
 *    and the target course are re-verified on ONE connection inside ONE
 *    transaction, each read locked `FOR UPDATE`;
 *  - a transition that changes nothing is a TRUTHFUL no-op: nothing is written,
 *    nothing is audited and the current stored projection is returned, so a
 *    retried publish never re-stamps `published_at`;
 *  - a confirmed transition writes the two publication columns and exactly ONE
 *    sanitized audit event, committed together;
 *  - an uncertain commit destroys the connection and never claims a rollback.
 */
router.put('/:id/publication', requireTeachingWrite('courses'), async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const courseId = String(req.params?.id ?? '');
    if (!UUID_PATTERN.test(courseId)) return res.status(404).json({ error: 'Course not found' });

    const tenantId = req.user?.tenantId;
    const callerId = req.user?.id;
    if (!tenantId || !callerId) {
        return res.status(403).json({ error: 'Teaching access is not active for the selected tenant' });
    }

    const parsed = parsePublicationBody(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const nextState = parsed.state;

    let connection: PoolConnection | null = null;
    let started = false;
    let commitAttempted = false;
    let disposal: 'release' | 'destroy' = 'release';

    const rollbackOrDiscard = async (): Promise<void> => {
        try { await connection!.rollback(); }
        catch { disposal = 'destroy'; }
    };

    try {
        connection = await getPool().getConnection();
        await connection.beginTransaction();
        started = true;

        const [memberRows] = await connection.execute<any[]>(MEMBER_LOCK_SELECT, [callerId, tenantId]);
        if (!isTeachingMember((memberRows as MembershipRow[])[0])) {
            await rollbackOrDiscard();
            return res.status(403).json({ error: 'Teaching access is not active for the selected tenant' });
        }

        const [courseRows] = await connection.execute<any[]>(COURSE_LOCK_SELECT, [courseId, tenantId]);
        const current = (courseRows as any[])[0];
        if (!current) {
            await rollbackOrDiscard();
            return res.status(404).json({ error: 'Course not found' });
        }

        const currentState = String(current.publication_state);
        if (currentState === nextState) {
            // Truthful no-op: write nothing, audit nothing, answer with the
            // current stored projection (and the ORIGINAL published_at).
            await rollbackOrDiscard();
            return res.json(publicationDto(current));
        }

        const [updateResult] = await connection.execute<any[]>(
            nextState === 'published' ? COURSE_PUBLISH_SQL : COURSE_UNPUBLISH_SQL,
            [courseId, tenantId],
        );
        if (Number((updateResult as any)?.affectedRows) !== 1) {
            await rollbackOrDiscard();
            return res.status(409).json({ error: 'Course was modified concurrently' });
        }

        // Exactly ONE sanitized audit event, committed with the write. The event
        // records WHO changed WHICH course into WHICH publication state. It
        // carries no name, description, price, student, lesson, file or
        // contact value, because this route changes none of them.
        await connection.execute(AUDIT_SQL, [
            randomUUID(),
            callerId,
            tenantId,
            nextState === 'published' ? 'course.published' : 'course.unpublished',
            'course',
            courseId,
            JSON.stringify({ publication_state: currentState }),
            JSON.stringify({ publication_state: nextState }),
        ]);

        // The row is read back inside the same transaction, so the response is
        // the stored projection including the SERVER publication instant.
        const [readRows] = await connection.execute<any[]>(COURSE_PUBLICATION_READ_SQL, [courseId, tenantId]);
        const updated = (readRows as any[])[0];
        if (!updated) {
            await rollbackOrDiscard();
            return res.status(500).json({ error: 'Failed to update course publication' });
        }

        commitAttempted = true;
        await connection.commit();
        return res.json(publicationDto(updated));
    } catch (error) {
        if (commitAttempted) {
            disposal = 'destroy';
            console.error('Course publication error after commit attempt (persistence uncertain):', error);
        } else if (started) {
            await rollbackOrDiscard();
            console.error('Course publication error:', error);
        } else {
            disposal = 'destroy';
            console.error('Course publication error before transaction start:', error);
        }
        return res.status(500).json({ error: 'Failed to update course publication' });
    } finally {
        if (connection) {
            if (disposal === 'destroy') { try { connection.destroy(); } catch { /* gone */ } }
            else { try { connection.release(); } catch { /* released */ } }
        }
    }
});


export default router;
