"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSqlPurposeContactStore = exports.PURPOSE_CONTACT_SQL_UNAVAILABLE_REASON = void 0;
exports.PURPOSE_CONTACT_SQL_UNAVAILABLE_REASON = 'purpose-scoped-contact-schema-not-declared';
const createSqlPurposeContactStore = () => ({
    configured: false,
    reason: exports.PURPOSE_CONTACT_SQL_UNAVAILABLE_REASON,
});
exports.createSqlPurposeContactStore = createSqlPurposeContactStore;
