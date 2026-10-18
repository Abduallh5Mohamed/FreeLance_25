import { Router, RequestHandler, Response } from 'express';
import { randomUUID } from 'crypto';
import { AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import { recordAudit, snapshotRow } from '../security/audit';
import {
    CERTIFICATE_STATUSES,
    CertificateStatus,
    generateVerificationId,
    isEligibleForCertificate,
    isRevoked,
    publicCertificateFacts,
} from '../services/certificates';

export interface CertificatesDataAccess {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
}

export interface CertificatesDeps {
    db: CertificatesDataAccess;
    authenticate: RequestHandler;
    loadActiveTenantAuthority: (userId: string, tenantId: string) => Promise<{ authority: string } | null>;
    /**
     * Guards the public `/verify/:verificationId` endpoint. The production
     * wiring supplies the per-client-address limiter; the factory itself stays
     * free of module-level throttle state so hermetic tests can drive it.
     */
    verifyRateLimit?: RequestHandler;
    now?: () => Date;
}

const STAFF_AUTHORITIES = new Set(['owner', 'instructor']);

interface CertRow {
    id: string;
    tenant_id: string;
    student_enrollment_id: string;
    course_id: string;
    verification_id: string;
    status: string;
    final_score: number | null;
    issued_at: string | Date;
    issued_by: string | null;
    revoked_at: string | Date | null;
    revoked_by: string | null;
    revoke_reason: string | null;
    branding_logo_url: string | null;
    branding_primary_color: string | null;
    branding_secondary_color: string | null;
    branding_accent_color: string | null;
    branding_locale: string | null;
}

export const createCertificatesRouter = (deps: CertificatesDeps): Router => {
    const router = Router();
    const { db } = deps;
    const now = deps.now ?? (() => new Date());

    const resolveStaffScope = async (req: AuthRequest, res: Response): Promise<{ tenantId: string; userId: string; isOwner: boolean } | null> => {
        const user = req.user;
        if (!user) { res.status(401).json({ error: 'Authentication required' }); return null; }
        const tenantId = user.tenantId;
        if (!tenantId) { res.status(403).json({ error: 'An active tenant membership is required' }); return null; }
        const authority = await deps.loadActiveTenantAuthority(user.id, tenantId);
        if (!authority || !STAFF_AUTHORITIES.has(authority.authority)) { res.status(403).json({ error: 'Tenant instructor authority required' }); return null; }
        return { tenantId, userId: user.id, isOwner: authority.authority === 'owner' };
    };

    const loadCert = async (tenantId: string, id: string): Promise<CertRow | null> =>
        db.queryOne<CertRow>('SELECT id, tenant_id, student_enrollment_id, course_id, verification_id, status, final_score, issued_at, issued_by, revoked_at, revoked_by, revoke_reason, branding_logo_url, branding_primary_color, branding_secondary_color, branding_accent_color, branding_locale FROM certificates WHERE tenant_id=? AND id=? LIMIT 1', [tenantId, id]);

    const loadBranding = async (tenantId: string): Promise<{ logo_url: string | null; primary_color: string | null; secondary_color: string | null; accent_color: string | null; locale: string | null } | null> =>
        db.queryOne('SELECT logo_url, primary_color, secondary_color, accent_color, locale FROM tenant_branding WHERE tenant_id=? LIMIT 1', [tenantId]);

    // Public verify endpoint (no auth). It is the only path reachable by an
    // anonymous caller and returns minimal facts only; the injected limiter
    // (production: per-client-address) bounds enumeration. Every path below
    // passes through deps.authenticate.
    const verifyPublicCertificate: RequestHandler = async (req: AuthRequest, res: Response) => {
        const verificationId = (req.params.verificationId ?? '').trim();
        if (!verificationId || verificationId.length > 128) { res.status(400).json({ error: 'invalid verification id' }); return; }
        const row = await db.queryOne<CertRow>('SELECT id, tenant_id, student_enrollment_id, course_id, verification_id, status, final_score, issued_at, issued_by, revoked_at, revoked_by, revoke_reason, branding_logo_url, branding_primary_color, branding_secondary_color, branding_accent_color, branding_locale FROM certificates WHERE verification_id=? LIMIT 1', [verificationId]);
        if (!row) { res.status(404).json({ error: 'Certificate not found' }); return; }
        const facts = publicCertificateFacts({
            verificationId: row.verification_id,
            status: row.status,
            issuedAt: row.issued_at,
            courseName: row.course_id,
            studentName: null,
            tenantName: row.tenant_id,
            finalScore: row.final_score,
            branding: {
                logoUrl: row.branding_logo_url,
                primaryColor: row.branding_primary_color,
                secondaryColor: row.branding_secondary_color,
                accentColor: row.branding_accent_color,
                locale: row.branding_locale,
            },
        });
        res.json({ certificate: facts });
    };
    const verifyHandlers: RequestHandler[] = deps.verifyRateLimit
        ? [deps.verifyRateLimit, verifyPublicCertificate]
        : [verifyPublicCertificate];
    router.get('/verify/:verificationId', ...verifyHandlers);

    router.use(deps.authenticate);

    // List
    router.get('/', async (req: AuthRequest, res: Response) => {
        const scope = await resolveStaffScope(req, res);
        if (!scope) return;
        const rows = await db.query<CertRow>('SELECT id, tenant_id, student_enrollment_id, course_id, verification_id, status, final_score, issued_at, issued_by, revoked_at, revoked_by, revoke_reason, branding_logo_url, branding_primary_color, branding_secondary_color, branding_accent_color, branding_locale FROM certificates WHERE tenant_id=? ORDER BY issued_at DESC LIMIT 500', [scope.tenantId]);
        res.json({ certificates: rows });
    });

    // Issue
    router.post('/', async (req: AuthRequest, res: Response) => {
        const scope = await resolveStaffScope(req, res);
        if (!scope) return;
        const body = req.body ?? {};
        const enrollmentId = (typeof body.student_enrollment_id === 'string' ? body.student_enrollment_id.trim() : (typeof body.enrollment_id === 'string' ? body.enrollment_id.trim() : ''));
        const courseId = (typeof body.course_id === 'string' ? body.course_id.trim() : (typeof body.courseId === 'string' ? body.courseId.trim() : ''));
        if (!enrollmentId || !courseId) { res.status(400).json({ error: 'student_enrollment_id and course_id are required' }); return; }
        // eligibility
        const eligible = isEligibleForCertificate({
            finalScore: body.final_score ?? body.finalScore ?? null,
            completedLessons: body.completed_lessons,
            totalLessons: body.total_lessons,
            allAssignmentsSubmitted: body.all_assignments_submitted,
            allExamsPassed: body.all_exams_passed,
            threshold: body.threshold,
        });
        if (!eligible) { res.status(400).json({ error: 'Student is not eligible for a certificate' }); return; }
        // duplicate check
        const existing = await db.queryOne<CertRow>('SELECT id FROM certificates WHERE tenant_id=? AND student_enrollment_id=? AND course_id=? LIMIT 1', [scope.tenantId, enrollmentId, courseId]);
        if (existing) { res.status(409).json({ error: 'Certificate already issued' }); return; }
        const branding = await loadBranding(scope.tenantId);
        const verificationId = generateVerificationId(32);
        const id = randomUUID();
        const finalScore = body.final_score ?? body.finalScore ?? null;
        try {
            await db.execute(
                'INSERT INTO certificates (id, tenant_id, student_enrollment_id, course_id, verification_id, status, final_score, issued_by, branding_logo_url, branding_primary_color, branding_secondary_color, branding_accent_color, branding_locale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [id, scope.tenantId, enrollmentId, courseId, verificationId, 'issued', finalScore, scope.userId, branding?.logo_url ?? null, branding?.primary_color ?? null, branding?.secondary_color ?? null, branding?.accent_color ?? null, branding?.locale ?? null],
            );
            await recordAudit(db.execute.bind(db) as never, { actorUserId: scope.userId, tenantId: scope.tenantId, action: 'certificate.issue', resourceType: 'certificate', resourceId: id, newValue: { enrollmentId, courseId, verificationId } });
        } catch (e) {
            res.status(500).json({ error: 'Failed to issue certificate' });
            return;
        }
        res.status(201).json({ id, verification_id: verificationId });
    });

    // Revoke
    router.post('/:id/revoke', async (req: AuthRequest, res: Response) => {
        const scope = await resolveStaffScope(req, res);
        if (!scope) return;
        const id = req.params.id.trim();
        const cert = await loadCert(scope.tenantId, id);
        if (!cert) { res.status(404).json({ error: 'Certificate not found' }); return; }
        if (cert.status === 'revoked') { res.status(409).json({ error: 'Already revoked' }); return; }
        const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 255) : null;
        try {
            await db.execute('UPDATE certificates SET status=?, revoked_at=CURRENT_TIMESTAMP, revoked_by=?, revoke_reason=? WHERE tenant_id=? AND id=? AND status=?', ['revoked', scope.userId, reason, scope.tenantId, id, 'issued']);
            await recordAudit(db.execute.bind(db) as never, { actorUserId: scope.userId, tenantId: scope.tenantId, action: 'certificate.revoke', resourceType: 'certificate', resourceId: id, oldValue: snapshotRow(cert), newValue: { status: 'revoked', reason } });
        } catch (e) {
            res.status(500).json({ error: 'Failed to revoke' });
            return;
        }
        res.json({ ok: true });
    });

    // Read
    router.get('/:id', async (req: AuthRequest, res: Response) => {
        const scope = await resolveStaffScope(req, res);
        if (!scope) return;
        const cert = await loadCert(scope.tenantId, req.params.id.trim());
        if (!cert) { res.status(404).json({ error: 'Certificate not found' }); return; }
        res.json({ certificate: cert });
    });

    return router;
};

// Production wiring: a lazily-resolved data access so importing this module in
// tests never constructs a pool, plus the default JWT authentication middleware.
let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => { dbModule ??= await import('../db'); return dbModule; };
const productionDb: CertificatesDataAccess = {
    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => { const { query } = await loadDb(); return query<T>(sql, params as never); },
    queryOne: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => { const { queryOne } = await loadDb(); return queryOne<T>(sql, params as never); },
    execute: async (sql: string, params?: unknown[]) => { const { execute } = await loadDb(); return execute(sql, params as never); },
};
const loadActiveTenantAuthority = async (userId: string, tenantId: string) => {
    const { queryOne } = await loadDb();
    return queryOne<{ authority: string }>(`SELECT m.role_key AS authority FROM tenant_memberships m INNER JOIN tenants t ON t.id=m.tenant_id AND t.status='active' INNER JOIN users u ON u.id=m.user_id AND u.is_active=1 WHERE m.user_id=? AND m.tenant_id=? AND m.status='active' LIMIT 1`, [userId, tenantId]);
};
export default createCertificatesRouter({
    db: productionDb,
    authenticate: async (req, res, next) => { const { authenticateToken } = await import('../middleware/auth'); return authenticateToken(req, res, next); },
    loadActiveTenantAuthority,
    // Only the public verify endpoint is anonymously reachable: throttle it per
    // client address to bound enumeration of verification ids.
    verifyRateLimit: rateLimit('certificates-verify', 30, 60_000),
});