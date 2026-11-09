"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PUBLIC_REGISTRATION_NAME_MAX_LENGTH = exports.PUBLIC_REGISTRATION_PASSWORD_MAX_LENGTH = exports.PUBLIC_REGISTRATION_PASSWORD_MIN_LENGTH = exports.resolvePublicRegistrationRole = void 0;
exports.validatePublicRegistrationInput = validatePublicRegistrationInput;
const phone_1 = require("./phone");
/**
 * Public registration creates student identities only.
 * Privileged accounts are provisioned through authenticated admin workflows.
 */
const resolvePublicRegistrationRole = (_requestedRole) => 'student';
exports.resolvePublicRegistrationRole = resolvePublicRegistrationRole;
exports.PUBLIC_REGISTRATION_PASSWORD_MIN_LENGTH = 8;
exports.PUBLIC_REGISTRATION_PASSWORD_MAX_LENGTH = 128;
exports.PUBLIC_REGISTRATION_NAME_MAX_LENGTH = 120;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * Fail-closed validation for public self-registration. The caller still
 * performs normalized existence checks and stores only the normalized
 * values returned here, so format variants of one phone number cannot
 * create duplicate identities.
 */
function validatePublicRegistrationInput(input) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) {
        return { ok: false, error: 'Name is required' };
    }
    if (name.length > exports.PUBLIC_REGISTRATION_NAME_MAX_LENGTH) {
        return { ok: false, error: 'Name is too long' };
    }
    if (typeof input.password !== 'string' || input.password.length < exports.PUBLIC_REGISTRATION_PASSWORD_MIN_LENGTH) {
        return { ok: false, error: `Password must be at least ${exports.PUBLIC_REGISTRATION_PASSWORD_MIN_LENGTH} characters` };
    }
    if (input.password.length > exports.PUBLIC_REGISTRATION_PASSWORD_MAX_LENGTH) {
        return { ok: false, error: 'Password is too long' };
    }
    const hasPhone = input.phone !== undefined && input.phone !== null && String(input.phone).trim() !== '';
    const hasEmail = input.email !== undefined && input.email !== null && String(input.email).trim() !== '';
    if (!hasPhone && !hasEmail) {
        return { ok: false, error: 'Phone (or email) and password are required' };
    }
    let phone = null;
    if (hasPhone) {
        phone = (0, phone_1.normalizeEgyptianPhone)(input.phone);
        if (!phone) {
            return { ok: false, error: 'Phone number is invalid' };
        }
    }
    let email = null;
    if (hasEmail) {
        email = String(input.email).toLowerCase().trim();
        if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
            return { ok: false, error: 'Email address is invalid' };
        }
    }
    return { ok: true, phone, email, name };
}
