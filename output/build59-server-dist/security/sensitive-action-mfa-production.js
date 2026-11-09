"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createProductionSensitiveActionMfa = createProductionSensitiveActionMfa;
const sensitive_action_mfa_1 = require("./sensitive-action-mfa");
const admin_permissions_1 = require("./admin-permissions");
const principal_repository_1 = require("./principal-repository");
const login_session_1 = require("./login-session");
const identity_scope_1 = require("./identity-scope");
const platform_mfa_1 = require("../services/platform-mfa");
/** Build a guard for an explicitly chosen action; no I/O until a request. */
function createProductionSensitiveActionMfa(policy) {
    return (0, sensitive_action_mfa_1.createRequireSensitiveActionMfa)({
        permissions: { isSuperAdmin: admin_permissions_1.isSuperAdmin, getAdminPermissions: admin_permissions_1.getAdminPermissions },
        sealKey: platform_mfa_1.mfaKeyFromEnv,
        now: Date.now,
        store: {
            findRow: async (userId) => {
                const db = await Promise.resolve().then(() => __importStar(require('../db')));
                return (0, platform_mfa_1.createSqlPlatformMfaStore)(db).findRow(userId);
            },
        },
        isIdentitySessionLive: async (userId, sessionId) => {
            const repository = principal_repository_1.defaultPrincipalRepository;
            if (!repository.findLoginSession)
                return false;
            const session = await repository.findLoginSession(sessionId, userId);
            if (!session || !(0, login_session_1.isLoginSessionLive)(session, {
                id: sessionId, userId, identitySource: session.identitySource,
                tokenVersion: session.tokenVersion,
            }, Date.now()))
                return false;
            if (session.identitySource === 'staff') {
                return (0, identity_scope_1.isStaffIdentityLive)(await repository.findStaffIdentity(userId), session.tokenVersion);
            }
            const identity = await repository.findUsersIdentity(userId);
            if (!identity?.role)
                return false;
            return (0, identity_scope_1.isUsersIdentityLive)(identity, session.tokenVersion, identity.role);
        },
    }, policy);
}
