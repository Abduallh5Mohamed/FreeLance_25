export type PublicRegistrationRole = 'student';

/**
 * Public registration creates student identities only.
 * Privileged accounts are provisioned through authenticated admin workflows.
 */
export const resolvePublicRegistrationRole = (_requestedRole: unknown): PublicRegistrationRole => 'student';
