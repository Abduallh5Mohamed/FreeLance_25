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

    const supplied = (key: string) => req.body?.[key] !== undefined ? String(req.body[key]) :
        req.query?.[key] !== undefined ? String(req.query[key]) : null;
    const allowedIdentity = new Set([principal.id, principal.studentEnrollmentId]);
    if (supplied('student_id') && !allowedIdentity.has(supplied('student_id')!)) return res.status(403).json({ error: 'Cross-student access denied' });
    if (supplied('tenant_id') && supplied('tenant_id') !== principal.tenantId) return res.status(403).json({ error: 'Cross-workspace access denied' });
    if (supplied('instructor_id') && supplied('instructor_id') !== principal.instructorId) return res.status(403).json({ error: 'Cross-workspace access denied' });
    if (supplied('group_id') && supplied('group_id') !== principal.groupId) return res.status(403).json({ error: 'Cross-group access denied' });
    if (supplied('grade_id') && supplied('grade_id') !== principal.gradeId) return res.status(403).json({ error: 'Cross-grade access denied' });
    return next();
};
