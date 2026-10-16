import { normalizeEgyptianPhone } from './phone';

export type PublicRegistrationRole = 'student';

/**
 * Public registration creates student identities only.
 * Privileged accounts are provisioned through authenticated admin workflows.
 */
export const resolvePublicRegistrationRole = (_requestedRole: unknown): PublicRegistrationRole => 'student';

export const PUBLIC_REGISTRATION_PASSWORD_MIN_LENGTH = 8;
export const PUBLIC_REGISTRATION_PASSWORD_MAX_LENGTH = 128;
export const PUBLIC_REGISTRATION_NAME_MAX_LENGTH = 120;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface PublicRegistrationInput {
    phone?: unknown;
    email?: unknown;
    password?: unknown;
    name?: unknown;
}

export type ValidatedRegistrationInput =
    | { ok: true; phone: string | null; email: string | null; name: string }
    | { ok: false; error: string };

/**
 * Fail-closed validation for public self-registration. The caller still
 * performs normalized existence checks and stores only the normalized
 * values returned here, so format variants of one phone number cannot
 * create duplicate identities.
 */
export function validatePublicRegistrationInput(input: PublicRegistrationInput): ValidatedRegistrationInput {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) {
        return { ok: false, error: 'Name is required' };
    }
    if (name.length > PUBLIC_REGISTRATION_NAME_MAX_LENGTH) {
        return { ok: false, error: 'Name is too long' };
    }

    if (typeof input.password !== 'string' || input.password.length < PUBLIC_REGISTRATION_PASSWORD_MIN_LENGTH) {
        return { ok: false, error: `Password must be at least ${PUBLIC_REGISTRATION_PASSWORD_MIN_LENGTH} characters` };
    }
    if (input.password.length > PUBLIC_REGISTRATION_PASSWORD_MAX_LENGTH) {
        return { ok: false, error: 'Password is too long' };
    }

    const hasPhone = input.phone !== undefined && input.phone !== null && String(input.phone).trim() !== '';
    const hasEmail = input.email !== undefined && input.email !== null && String(input.email).trim() !== '';
    if (!hasPhone && !hasEmail) {
        return { ok: false, error: 'Phone (or email) and password are required' };
    }

    let phone: string | null = null;
    if (hasPhone) {
        phone = normalizeEgyptianPhone(input.phone);
        if (!phone) {
            return { ok: false, error: 'Phone number is invalid' };
        }
    }

    let email: string | null = null;
    if (hasEmail) {
        email = String(input.email).toLowerCase().trim();
        if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
            return { ok: false, error: 'Email address is invalid' };
        }
    }

    return { ok: true, phone, email, name };
}
