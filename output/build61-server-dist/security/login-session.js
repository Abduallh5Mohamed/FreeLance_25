"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validSessionId = void 0;
exports.isLoginSessionLive = isLoginSessionLive;
exports.createLoginSessionAuthority = createLoginSessionAuthority;
const node_crypto_1 = require("node:crypto");
const validSessionId = (value) => typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
exports.validSessionId = validSessionId;
const safeInstant = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/** Identity liveness and capability checks remain independent prerequisites. */
function isLoginSessionLive(row, expected, nowMs) {
    return row !== null && (0, exports.validSessionId)(expected.id)
        && row.id === expected.id && row.userId === expected.userId
        && row.identitySource === expected.identitySource
        && Number.isSafeInteger(expected.tokenVersion) && expected.tokenVersion >= 0
        && row.tokenVersion === expected.tokenVersion
        && safeInstant(nowMs) && safeInstant(row.issuedAtMs) && safeInstant(row.expiresAtMs)
        && row.issuedAtMs <= nowMs && nowMs < row.expiresAtMs
        && row.expiresAtMs > row.issuedAtMs && row.revokedAtMs === null;
}
function createLoginSessionAuthority(store, now = Date.now) {
    if (!store || typeof store.insert !== 'function' || typeof store.find !== 'function'
        || typeof store.revoke !== 'function' || typeof now !== 'function') {
        throw new Error('Login sessions require a durable scoped store and clock');
    }
    return {
        async issue(input) {
            const at = now();
            if (typeof input.userId !== 'string' || !input.userId.trim() || input.userId.trim() !== input.userId
                || input.userId.length > 36 || !['users', 'staff'].includes(input.identitySource)
                || !Number.isSafeInteger(input.tokenVersion) || input.tokenVersion < 0
                || !safeInstant(at) || !safeInstant(input.expiresAtMs) || input.expiresAtMs <= at) {
                throw new Error('Invalid login session identity or lifetime');
            }
            const record = {
                id: (0, node_crypto_1.randomUUID)(), ...input, issuedAtMs: at, revokedAtMs: null,
            };
            await store.insert(record);
            return Object.freeze(record);
        },
        async verify(expected) {
            if (!(0, exports.validSessionId)(expected.id))
                return false;
            return isLoginSessionLive(await store.find(expected.id, expected.userId), expected, now());
        },
        async revoke(id, userId) {
            const at = now();
            if (!(0, exports.validSessionId)(id) || !userId || !safeInstant(at))
                throw new Error('Invalid session revocation');
            await store.revoke(id, userId, at);
        },
    };
}
