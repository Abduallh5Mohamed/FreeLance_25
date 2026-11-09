"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createFamilySummaryRouter = createFamilySummaryRouter;
const express_1 = require("express");
const family_summary_1 = require("../services/family-summary");
function createFamilySummaryRouter(deps) {
    const router = (0, express_1.Router)();
    router.get('/', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.set('Vary', 'Authorization');
        if (Object.keys(req.query).length || Object.keys(req.body ?? {}).length
            || ['x-tenant-id', 'x-student-enrollment-id', 'x-impersonation', 'x-impersonate-user', 'x-impersonate-user-id'].some(h => req.headers[h] !== undefined)) {
            return res.status(400).json({ code: 'FAMILY_SELECTORS_DENIED' });
        }
        const match = /^Bearer\s+([^\s]+)$/i.exec(req.headers.authorization ?? '');
        if (!match)
            return res.status(401).json({ code: 'FAMILY_SESSION_REQUIRED' });
        try {
            const before = await deps.verifier.verify(match[1]);
            if (!before.ok)
                return res.status(before.reason === 'secret-unavailable' ? 503 : 401).json({ code: 'FAMILY_SESSION_UNAVAILABLE' });
            if (before.link.status !== 'active' || before.link.revoked_at !== null)
                return res.status(401).json({ code: 'FAMILY_SESSION_UNAVAILABLE' });
            const claims = before.claims;
            const summary = await (0, family_summary_1.readFamilySummary)(deps.db, { tenantId: claims.tenant_id,
                studentEnrollmentId: claims.student_enrollment_id, parentUserId: claims.parent_user_id }, (deps.now ?? (() => new Date()))());
            const after = await deps.verifier.verify(match[1]);
            if (!after.ok)
                return res.status(after.reason === 'secret-unavailable' ? 503 : 401).json({ code: 'FAMILY_SESSION_UNAVAILABLE' });
            if (after.link.status !== 'active' || after.link.revoked_at !== null)
                return res.status(401).json({ code: 'FAMILY_SESSION_UNAVAILABLE' });
            if (JSON.stringify(after.claims) !== JSON.stringify(claims))
                return res.status(401).json({ code: 'FAMILY_SESSION_UNAVAILABLE' });
            return res.json(summary);
        }
        catch (error) {
            // Never log scoped tokens or child payloads, including driver details.
            return res.status(error instanceof family_summary_1.FamilyScopeLost ? 404 : 503).json({ code: 'FAMILY_SUMMARY_UNAVAILABLE' });
        }
    });
    return router;
}
