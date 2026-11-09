"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setNoStoreCacheHeaders = void 0;
/**
 * Per-tenant ledger and export responses must never be stored by shared
 * caches (same contract as files.ts downloads and secure-video responses).
 */
const setNoStoreCacheHeaders = (res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Pragma', 'no-cache');
};
exports.setNoStoreCacheHeaders = setNoStoreCacheHeaders;
