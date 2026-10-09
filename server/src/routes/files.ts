import { Router, Response } from 'express';
import path from 'path';
import { queryOne } from '../db';
import { AuthRequest, authenticateToken } from '../middleware/auth';

const router = Router();
const uploadRoot = path.resolve(process.cwd(), 'uploads');

router.get('/:fileId/download', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const tenantId = req.user?.tenantId;
        if (!tenantId) return res.status(403).json({ error: 'Tenant membership required' });
        const file = await queryOne<{ storage_path: string; mime_type: string; original_name: string }>(
            'SELECT storage_path,mime_type,original_name FROM tenant_media_files WHERE id=? AND tenant_id=?',
            [req.params.fileId, tenantId]
        );
        if (!file) return res.status(404).json({ error: 'File not found' });
        const absolutePath = path.resolve(process.cwd(), file.storage_path);
        if (!absolutePath.startsWith(`${uploadRoot}${path.sep}`)) return res.status(404).json({ error: 'File not found' });
        res.setHeader('Content-Type', file.mime_type);
        res.setHeader('Content-Disposition', `inline; filename="${path.basename(file.original_name).replace(/["\r\n]/g, '_')}"`);
        res.setHeader('Cache-Control', 'private, no-store');
        return res.sendFile(absolutePath, error => {
            if (error && !res.headersSent) res.status((error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500).end();
        });
    } catch (error) {
        console.error('[Files] Tenant download failed:', error);
        return res.status(500).json({ error: 'File download failed' });
    }
});

export default router;
