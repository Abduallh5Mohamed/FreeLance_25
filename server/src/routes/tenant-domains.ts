import { Router, Response, RequestHandler } from 'express';
import { randomUUID } from 'crypto';
import { query, queryOne, execute } from '../db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { resolveTxtViaDns } from '../services/domain-verification';
import {
  validateCustomHostname,
  canClaimDomain,
  createMemoryDomainClaimStore,
  createSqlDomainClaimStore,
  generateVerificationToken,
  buildTxtRecordName,
  buildTxtRecordValue,
  verifyDomainOwnership,
  type DomainClaimStore,
  type TxtResolver,
} from '../services/domain-verification';
import { recordAudit } from '../security/audit';

export interface TenantDomainsDataAccess {
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>;
  queryOne: <T = unknown>(sql: string, params?: unknown[]) => Promise<T | null>;
  execute: (sql: string, params?: unknown[]) => Promise<{ affectedRows: number; insertId?: number }>;
}

export interface TenantDomainsDeps {
  db?: Partial<TenantDomainsDataAccess>;
  query?: TenantDomainsDataAccess['query'];
  queryOne?: TenantDomainsDataAccess['queryOne'];
  execute?: TenantDomainsDataAccess['execute'];
  authenticate?: RequestHandler;
  auth?: RequestHandler;
  loadActiveTenantAuthority?: (userId: string, tenantId: string) => Promise<{ authority: string } | null>;
  isTenantOwner?: (userId: string, tenantId: string) => Promise<boolean>;
  domainClaimStore?: DomainClaimStore;
  claimStore?: DomainClaimStore;
  store?: DomainClaimStore;
  txtResolver?: TxtResolver;
  resolveTxt?: TxtResolver;
  dnsResolveTxt?: TxtResolver;
  audit?: (input: Record<string, unknown>) => Promise<void>;
}

const CHALLENGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function dbOf(deps: TenantDomainsDeps): TenantDomainsDataAccess {
  const db = deps.db ?? {};
  const query = (deps.query ?? db.query) as TenantDomainsDataAccess['query'] | undefined;
  const queryOne = (deps.queryOne ?? db.queryOne) as TenantDomainsDataAccess['queryOne'] | undefined;
  const execute = (deps.execute ?? db.execute) as TenantDomainsDataAccess['execute'] | undefined;
  if (!query || !queryOne || !execute) throw new Error('Tenant domains router requires query/queryOne/execute');
  return { query, queryOne, execute };
}

function authOf(deps: TenantDomainsDeps): RequestHandler {
  return deps.authenticate ?? deps.auth ?? ((req, _res, next) => next());
}

function storeOf(deps: TenantDomainsDeps, db: TenantDomainsDataAccess): DomainClaimStore {
  return deps.domainClaimStore ?? deps.claimStore ?? deps.store ?? createSqlDomainClaimStore(db);
}

function txtResolverOf(deps: TenantDomainsDeps): TxtResolver {
  return deps.txtResolver ?? deps.resolveTxt ?? deps.dnsResolveTxt ?? resolveTxtViaDns;
}

async function resolveOwnedTenant(
  req: AuthRequest,
  db: TenantDomainsDataAccess,
  deps: TenantDomainsDeps,
): Promise<{ id: string; business_name: string; status: string } | null> {
  const userId = req.user?.id;
  const tenantId = req.user?.tenantId;
  if (!userId || !tenantId) return null;
  if (deps.loadActiveTenantAuthority) {
    const authority = await deps.loadActiveTenantAuthority(userId, tenantId);
    if (!authority || authority.authority !== 'owner') return null;
  } else if (deps.isTenantOwner) {
    if (!(await deps.isTenantOwner(userId, tenantId))) return null;
  } else {
    const owner = await db.queryOne<{ id: string }>(
      `SELECT id FROM tenants WHERE id = ? AND owner_user_id = ? AND status = 'active' LIMIT 1`,
      [tenantId, userId],
    );
    if (!owner) return null;
  }
  const tenant = await db.queryOne<{ id: string; business_name: string; status: string }>(
    `SELECT id, business_name, status FROM tenants WHERE id = ? LIMIT 1`,
    [tenantId],
  );
  if (!tenant || tenant.status !== 'active') return null;
  return tenant;
}

function isExpired(claim: { createdAt: string; expiresAt?: string | null }): boolean {
  if (claim.expiresAt) {
    const t = Date.parse(claim.expiresAt);
    if (!Number.isNaN(t)) return Date.now() > t;
  }
  const created = Date.parse(claim.createdAt);
  if (Number.isNaN(created)) return false;
  return Date.now() - created > CHALLENGE_TTL_MS;
}

export const createTenantDomainsRouter = (deps: TenantDomainsDeps = {}): Router => {
  const db = dbOf(deps);
  const store = storeOf(deps, db);
  const router = Router();
  router.use(authOf(deps));

  // List claims
  router.get(['/', '/domains'], async (req: AuthRequest, res: Response) => {
    try {
      const tenant = await resolveOwnedTenant(req, db, deps);
      if (!tenant) return res.status(403).json({ error: 'Tenant owner access required' });
      const claims = await store.listByTenant(tenant.id);
      return res.json(claims);
    } catch (error) {
      console.error('Tenant domains list error:', error);
      return res.status(500).json({ error: 'Failed to list domains' });
    }
  });

  // Claim a domain
  const claimHandler = async (req: AuthRequest, res: Response) => {
    try {
      const tenant = await resolveOwnedTenant(req, db, deps);
      if (!tenant) return res.status(403).json({ error: 'Tenant owner access required' });

      const hostnameRaw = req.body?.hostname ?? req.params?.hostname ?? req.query?.hostname;
      const validated = validateCustomHostname(hostnameRaw);
      if (!validated.ok) return res.status(400).json({ error: validated.reason, code: validated.code });

      const existing = await store.findByHostname(validated.hostname);
      const permission = canClaimDomain(existing, tenant.id);
      if (!permission.allowed) return res.status(409).json({ error: 'Domain is already claimed by another tenant' });

      const token = generateVerificationToken();
      const txtName = buildTxtRecordName(validated.hostname);
      const claim = await store.savePendingClaim({
        hostname: validated.hostname,
        tenantId: tenant.id,
        token,
        txtName,
      });

      const auditFn = deps.audit;
      const runAudit = async () => {
        if (auditFn) {
          await auditFn({
            actorUserId: req.user!.id,
            tenantId: tenant.id,
            action: 'tenant.domain.claimed',
            resourceType: 'tenant_custom_domain',
            resourceId: validated.hostname,
            newValue: claim,
          });
        } else {
          await recordAudit(db.execute, {
            actorUserId: req.user!.id,
            tenantId: tenant.id,
            action: 'tenant.domain.claimed',
            resourceType: 'tenant_custom_domain',
            resourceId: validated.hostname,
            newValue: claim,
          });
        }
      };
      try {
        await runAudit();
      } catch (error) {
        console.error('Tenant domain claim audit error:', error);
        return res.status(500).json({ error: 'Failed to claim domain' });
      }

      return res.status(201).json({
        hostname: claim.hostname,
        status: claim.status,
        token: claim.token,
        txt_record_name: claim.txtName,
        txt_record_value: buildTxtRecordValue(claim.token),
        challenge_expires_at: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
      });
    } catch (error) {
      console.error('Tenant domain claim error:', error);
      return res.status(500).json({ error: 'Failed to claim domain' });
    }
  };

  router.post(['/', '/claim', '/domains'], claimHandler);

  // Verify a domain
  const verifyHandler = async (req: AuthRequest, res: Response) => {
    try {
      const tenant = await resolveOwnedTenant(req, db, deps);
      if (!tenant) return res.status(403).json({ error: 'Tenant owner access required' });

      const hostnameRaw = req.body?.hostname ?? req.params?.hostname ?? req.query?.hostname;
      const validated = validateCustomHostname(hostnameRaw);
      if (!validated.ok) return res.status(400).json({ error: validated.reason, code: validated.code });

      const claim = await store.findByHostname(validated.hostname);
      if (!claim || claim.tenantId !== tenant.id) return res.status(404).json({ error: 'Domain claim not found' });

      if (isExpired(claim)) return res.status(400).json({ error: 'Challenge expired' });

      const resolver = txtResolverOf(deps);
      const result = await verifyDomainOwnership({
        hostname: validated.hostname,
        expectedToken: claim.token,
        resolveTxt: resolver,
      });
      if (!result.verified) return res.status(400).json({ error: 'Domain verification failed', reason: result.reason });

      const verified = await store.markVerified(validated.hostname, tenant.id);
      if (!verified) return res.status(400).json({ error: 'Domain verification failed' });

      const auditFn = deps.audit;
      const runAudit = async () => {
        if (auditFn) {
          await auditFn({
            actorUserId: req.user!.id,
            tenantId: tenant.id,
            action: 'tenant.domain.verified',
            resourceType: 'tenant_custom_domain',
            resourceId: validated.hostname,
            oldValue: claim,
            newValue: verified,
          });
        } else {
          await recordAudit(db.execute, {
            actorUserId: req.user!.id,
            tenantId: tenant.id,
            action: 'tenant.domain.verified',
            resourceType: 'tenant_custom_domain',
            resourceId: validated.hostname,
            oldValue: claim,
            newValue: verified,
          });
        }
      };
      try {
        await runAudit();
      } catch (error) {
        console.error('Tenant domain verify audit error:', error);
        return res.status(500).json({ error: 'Failed to verify domain' });
      }

      return res.json(verified);
    } catch (error) {
      console.error('Tenant domain verify error:', error);
      return res.status(500).json({ error: 'Failed to verify domain' });
    }
  };

  router.post(['/:hostname/verify', '/verify'], verifyHandler);

  // Revoke a domain
  const revokeHandler = async (req: AuthRequest, res: Response) => {
    try {
      const tenant = await resolveOwnedTenant(req, db, deps);
      if (!tenant) return res.status(403).json({ error: 'Tenant owner access required' });

      const hostnameRaw = req.body?.hostname ?? req.params?.hostname ?? req.query?.hostname;
      const validated = validateCustomHostname(hostnameRaw);
      if (!validated.ok) return res.status(400).json({ error: validated.reason, code: validated.code });

      const claim = await store.findByHostname(validated.hostname);
      if (!claim || claim.tenantId !== tenant.id) return res.status(404).json({ error: 'Domain claim not found' });

      const deleted = await store.deleteClaim(validated.hostname, tenant.id);
      if (!deleted) return res.status(404).json({ error: 'Domain claim not found' });

      const auditFn = deps.audit;
      const runAudit = async () => {
        if (auditFn) {
          await auditFn({
            actorUserId: req.user!.id,
            tenantId: tenant.id,
            action: 'tenant.domain.revoked',
            resourceType: 'tenant_custom_domain',
            resourceId: validated.hostname,
            oldValue: claim,
          });
        } else {
          await recordAudit(db.execute, {
            actorUserId: req.user!.id,
            tenantId: tenant.id,
            action: 'tenant.domain.revoked',
            resourceType: 'tenant_custom_domain',
            resourceId: validated.hostname,
            oldValue: claim,
          });
        }
      };
      try {
        await runAudit();
      } catch (error) {
        console.error('Tenant domain revoke audit error:', error);
        return res.status(500).json({ error: 'Failed to revoke domain' });
      }

      return res.json({ revoked: true, hostname: validated.hostname });
    } catch (error) {
      console.error('Tenant domain revoke error:', error);
      return res.status(500).json({ error: 'Failed to revoke domain' });
    }
  };

  router.delete(['/:hostname', '/revoke', '/domains/:hostname'], revokeHandler);

  return router;
};

const loadActiveTenantAuthority = async (userId: string, tenantId: string) =>
  queryOne<{ authority: string }>(
    `SELECT 'owner' AS authority
     FROM tenants t
     WHERE t.id = ? AND t.owner_user_id = ? AND t.status = 'active'
     UNION ALL
     SELECT m.role_key AS authority
     FROM tenant_memberships m
     INNER JOIN tenants t ON t.id = m.tenant_id
     INNER JOIN users u ON u.id = m.user_id
     WHERE m.user_id = ? AND m.tenant_id = ? AND m.status = 'active'
       AND t.status = 'active' AND u.is_active = 1
       AND m.role_key IN ('owner','instructor')
     LIMIT 1`,
    [tenantId, userId, userId, tenantId],
  );

export default createTenantDomainsRouter({
  db: { query, queryOne, execute },
  authenticate: authenticateToken,
  loadActiveTenantAuthority,
  txtResolver: resolveTxtViaDns,
});
