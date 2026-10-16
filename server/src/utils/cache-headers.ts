import type { Response } from 'express';

/**
 * Per-tenant ledger and export responses must never be stored by shared
 * caches (same contract as files.ts downloads and secure-video responses).
 */
export const setNoStoreCacheHeaders = (res: Response): void => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Pragma', 'no-cache');
};
