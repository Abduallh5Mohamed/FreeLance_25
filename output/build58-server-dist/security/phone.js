"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeEgyptianPhone = normalizeEgyptianPhone;
exports.phoneLookupCandidates = phoneLookupCandidates;
/** Normalize Egyptian mobile numbers to E.164 (+20...). */
function normalizeEgyptianPhone(input) {
    const raw = String(input ?? '').trim().replace(/[\s()-]/g, '');
    if (!raw)
        return null;
    let digits = raw.replace(/^\+/, '').replace(/\D/g, '');
    if (digits.startsWith('0020'))
        digits = digits.slice(2);
    if (digits.startsWith('20'))
        digits = digits.slice(2);
    if (digits.startsWith('0'))
        digits = digits.slice(1);
    if (!/^1[0125]\d{8}$/.test(digits))
        return null;
    return `+20${digits}`;
}
function phoneLookupCandidates(input) {
    const normalized = normalizeEgyptianPhone(input);
    if (!normalized)
        return [];
    const national = `0${normalized.slice(3)}`;
    return Array.from(new Set([normalized, national, normalized.slice(1)]));
}
