import type { PurposeContactStore } from './delivery-channels';

export const PURPOSE_CONTACT_SQL_UNAVAILABLE_REASON = 'purpose-scoped-contact-schema-not-declared';

export type PurposeContactSqlUnavailableReason = typeof PURPOSE_CONTACT_SQL_UNAVAILABLE_REASON;

export type PurposeContactSqlResult =
    | { configured: true; store: PurposeContactStore }
    | { configured: false; reason: PurposeContactSqlUnavailableReason };

export const createSqlPurposeContactStore = (): PurposeContactSqlResult => ({
    configured: false,
    reason: PURPOSE_CONTACT_SQL_UNAVAILABLE_REASON,
});
