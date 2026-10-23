import { createRequireSensitiveActionMfa, type SensitiveActionMfaPolicy } from './sensitive-action-mfa';
import { isSuperAdmin, getAdminPermissions } from './admin-permissions';
import { defaultPrincipalRepository } from './principal-repository';
import { isLoginSessionLive } from './login-session';
import { isStaffIdentityLive, isUsersIdentityLive } from './identity-scope';
import { createSqlPlatformMfaStore, mfaKeyFromEnv } from '../services/platform-mfa';

/** Build a guard for an explicitly chosen action; no I/O until a request. */
export function createProductionSensitiveActionMfa(policy: SensitiveActionMfaPolicy) {
    return createRequireSensitiveActionMfa({
        permissions: { isSuperAdmin, getAdminPermissions },
        sealKey: mfaKeyFromEnv,
        now: Date.now,
        store: {
            findRow: async userId => {
                const db = await import('../db');
                return createSqlPlatformMfaStore(db).findRow(userId);
            },
        },
        isIdentitySessionLive: async (userId, sessionId) => {
            const repository = defaultPrincipalRepository;
            if (!repository.findLoginSession) return false;
            const session = await repository.findLoginSession(sessionId, userId);
            if (!session || !isLoginSessionLive(session, {
                id: sessionId, userId, identitySource: session.identitySource,
                tokenVersion: session.tokenVersion,
            }, Date.now())) return false;
            if (session.identitySource === 'staff') {
                return isStaffIdentityLive(await repository.findStaffIdentity(userId), session.tokenVersion);
            }
            const identity = await repository.findUsersIdentity(userId);
            if (!identity?.role) return false;
            return isUsersIdentityLive(identity, session.tokenVersion, identity.role);
        },
    }, policy);
}
