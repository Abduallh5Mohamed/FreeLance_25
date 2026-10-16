import { NextFunction, Response } from 'express';
import { AuthRequest } from './auth';

/**
 * Rejects student-supplied identity and workspace substitutions at the API
 * boundary. Resource ownership checks still belong in each route/service.
 */
export const enforceStudentWorkspaceBoundary = (req: AuthRequest, res: Response, next: NextFunction) => {
    const principal = req.user;
    if (!principal || principal.role !== 'student') return next();

    const pathName = req.path.split('?')[0];
    const unscopedAllowed = pathName === '/auth/me' || pathName.startsWith('/student-enrollment/spaces') ||
        pathName.startsWith('/student-enrollment/join/') || pathName.startsWith('/support-tickets');
    if (!principal.studentEnrollmentId || !principal.tenantId) {
        if (unscopedAllowed) return next();
        return res.status(409).json({ error: 'Select an instructor workspace first', code: 'STUDENT_SPACE_REQUIRED' });
    }

    const supplied = (key: string): string | null => {
        const fromBody = (req.body as Record<string, unknown> | undefined)?.[key];
        if (fromBody !== undefined && fromBody !== null && String(fromBody).length > 0) return String(fromBody);
        const fromQuery = (req.query as Record<string, unknown> | undefined)?.[key];
        if (fromQuery !== undefined && fromQuery !== null && String(fromQuery).length > 0) return String(fromQuery);
        const fromParams = (req.params as Record<string, unknown> | undefined)?.[key];
        if (fromParams !== undefined && fromParams !== null && String(fromParams).length > 0) return String(fromParams);
        return null;
    };
    const allowedIdentity = new Set([principal.id, principal.studentEnrollmentId].filter(Boolean) as string[]);
    const studentKeys = ['student_id', 'studentId', 'student_enrollment_id', 'otherUserId', 'other_user_id'];
    for (const key of studentKeys) {
        const value = supplied(key);
        if (value && !allowedIdentity.has(value)) {
            // otherUserId/receiver keys name a conversation peer, not a
            // student substitution; the route's own participant + relation
            // check owns that decision, so only generic student keys deny here.
            if (key === 'otherUserId' || key === 'other_user_id') continue;
            return res.status(403).json({ error: 'Cross-student access denied' });
        }
    }
    // Messaging peers travel as receiver_id/receiverId (body) or :userId
    // (params). A student may only name their assigned instructor or the
    // legacy teacher workspace; anything else is a cross-workspace attempt.
    // The route's relation check still denies, this fails fast at the boundary.
    const receiver = supplied('receiver_id') ?? supplied('receiverId') ?? supplied('userId');
    if (receiver && principal.instructorId) {
        // Teacher workspace identity is not enumerable here; allow the
        // relation check in the route to decide, but block an obvious
        // self-echo that can never be legitimate.
        if (receiver === principal.id || receiver === principal.studentEnrollmentId) {
            return res.status(403).json({ error: 'Cross-student access denied' });
        }
    }
    if (supplied('tenant_id') && supplied('tenant_id') !== principal.tenantId) return res.status(403).json({ error: 'Cross-workspace access denied' });
    if (supplied('tenantId') && supplied('tenantId') !== principal.tenantId) return res.status(403).json({ error: 'Cross-workspace access denied' });
    if (supplied('instructor_id') && supplied('instructor_id') !== principal.instructorId) return res.status(403).json({ error: 'Cross-workspace access denied' });
    if (supplied('instructorId') && supplied('instructorId') !== principal.instructorId) return res.status(403).json({ error: 'Cross-workspace access denied' });
    if (supplied('group_id') && supplied('group_id') !== principal.groupId) return res.status(403).json({ error: 'Cross-group access denied' });
    if (supplied('groupId') && supplied('groupId') !== principal.groupId) return res.status(403).json({ error: 'Cross-group access denied' });
    if (supplied('grade_id') && supplied('grade_id') !== principal.gradeId) return res.status(403).json({ error: 'Cross-grade access denied' });
    if (supplied('gradeId') && supplied('gradeId') !== principal.gradeId) return res.status(403).json({ error: 'Cross-grade access denied' });
    return next();
};
