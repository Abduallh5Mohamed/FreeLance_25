import { Router, Response, RequestHandler } from 'express';
import { randomUUID } from 'crypto';
import { query, queryOne, execute } from '../db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { recordAudit } from '../security/audit';
import { validateCustomHostname } from '../services/domain-verification';

export interface TenantBrandingDataAccess {
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>;
  queryOne: <T = unknown>(sql: string, params?: unknown[]) => Promise<T | null>;
  execute: (sql: string, params?: unknown[]) => Promise<{ affectedRows?: number; insertId?: number }>;
}

export interface TenantBrandingDeps {
  db?: Partial<TenantBrandingDataAccess>;
  query?: TenantBrandingDataAccess['query'];
  queryOne?: TenantBrandingDataAccess['queryOne'];
  execute?: TenantBrandingDataAccess['execute'];
  authenticate?: RequestHandler;
  auth?: RequestHandler;
  loadActiveTenantAuthority?: (userId: string, tenantId: string) => Promise<{ authority: string } | null>;
  isTenantOwner?: (userId: string, tenantId: string) => Promise<boolean>;
  audit?: (input: Record<string, unknown>) => Promise<void>;
}

function dbOf(deps: TenantBrandingDeps): TenantBrandingDataAccess {
  const db = deps.db ?? {};
  const query = (deps.query ?? db.query) as TenantBrandingDataAccess['query'] | undefined;
  const queryOne = (deps.queryOne ?? db.queryOne) as TenantBrandingDataAccess['queryOne'] | undefined;
  const execute = (deps.execute ?? db.execute) as TenantBrandingDataAccess['execute'] | undefined;
  if (!query || !queryOne || !execute) throw new Error('Tenant branding router requires query/queryOne/execute');
  return { query, queryOne, execute };
}

function authOf(deps: TenantBrandingDeps): RequestHandler {
  return deps.authenticate ?? deps.auth ?? ((req, _res, next) => next());
}

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value);
}

function isValidUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

async function resolveOwnedTenant(
  req: AuthRequest,
  db: TenantBrandingDataAccess,
  deps: TenantBrandingDeps,
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

function readBrandingBody(body: unknown): {
  ok: true;
  data: {
    logo_url?: string | null;
    primary_color?: string | null;
    secondary_color?: string | null;
    accent_color?: string | null;
    locale?: string;
    rtl?: boolean;
  };
} | { ok: false; error: string } {
  const rec = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const data: {
    logo_url?: string | null;
    primary_color?: string | null;
    secondary_color?: string | null;
    accent_color?: string | null;
    locale?: string;
    rtl?: boolean;
  } = {};

  const logo = rec.logo_url ?? rec.logoUrl;
  if (logo !== undefined) {
    if (logo === null || logo === '') data.logo_url = null;
    else if (isValidUrl(logo)) data.logo_url = logo as string;
    else return { ok: false, error: 'Invalid logo_url' };
  }

  const pc = rec.primary_color ?? rec.primaryColor ?? rec.color_primary;
  if (pc !== undefined) {
    if (pc === null || pc === '') data.primary_color = null;
    else if (isHexColor(pc)) data.primary_color = pc as string;
    else return { ok: false, error: 'Invalid primary_color' };
  }
  const sc = rec.secondary_color ?? rec.secondaryColor ?? rec.color_secondary;
  if (sc !== undefined) {
    if (sc === null || sc === '') data.secondary_color = null;
    else if (isHexColor(sc)) data.secondary_color = sc as string;
    else return { ok: false, error: 'Invalid secondary_color' };
  }
  const ac = rec.accent_color ?? rec.accentColor ?? rec.color_accent;
  if (ac !== undefined) {
    if (ac === null || ac === '') data.accent_color = null;
    else if (isHexColor(ac)) data.accent_color = ac as string;
    else return { ok: false, error: 'Invalid accent_color' };
  }

  const locale = rec.locale ?? rec.language;
  if (locale !== undefined) {
    if (locale !== 'ar' && locale !== 'en') return { ok: false, error: 'locale must be ar or en' };
    data.locale = locale as string;
  }

  const rtl = rec.rtl ?? rec.rtl_flag ?? rec.is_rtl;
  if (rtl !== undefined) {
    if (typeof rtl !== 'boolean') return { ok: false, error: 'rtl must be boolean' };
    data.rtl = rtl;
  }

  if (Object.keys(data).length === 0) return { ok: false, error: 'Nothing to update' };
  return { ok: true, data };
}

export const createTenantBrandingRouter = (deps: TenantBrandingDeps = {}): Router => {
  const db = dbOf(deps);
  const router = Router();
  router.use(authOf(deps));

  router.get(['/', '/branding', '/me'], async (req: AuthRequest, res: Response) => {
    try {
      const tenant = await resolveOwnedTenant(req, db, deps);
      if (!tenant) return res.status(403).json({ error: 'Tenant owner access required' });
      const branding = await db.queryOne<Record<string, unknown>>(
        `SELECT tenant_id, logo_url, primary_color, secondary_color, accent_color, locale, rtl, created_at, updated_at
         FROM tenant_branding WHERE tenant_id = ? LIMIT 1`,
        [tenant.id],
      );
      return res.json(
        branding ?? {
          tenant_id: tenant.id,
          logo_url: null,
          primary_color: null,
          secondary_color: null,
          accent_color: null,
          locale: 'ar',
          rtl: true,
        },
      );
    } catch (error) {
      console.error('Tenant branding get error:', error);
      return res.status(500).json({ error: 'Failed to load branding' });
    }
  });

  const upsert = async (req: AuthRequest, res: Response) => {
    try {
      const tenant = await resolveOwnedTenant(req, db, deps);
      if (!tenant) return res.status(403).json({ error: 'Tenant owner access required' });

      const parsed = readBrandingBody(req.body);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });

      const oldRow = await db.queryOne<Record<string, unknown>>(
        `SELECT logo_url, primary_color, secondary_color, accent_color, locale, rtl FROM tenant_branding WHERE tenant_id = ? LIMIT 1`,
        [tenant.id],
      );

      const fields: string[] = [];
      const values: unknown[] = [];
      const data = parsed.data;
      if (data.logo_url !== undefined) { fields.push('logo_url = ?'); values.push(data.logo_url); }
      if (data.primary_color !== undefined) { fields.push('primary_color = ?'); values.push(data.primary_color); }
      if (data.secondary_color !== undefined) { fields.push('secondary_color = ?'); values.push(data.secondary_color); }
      if (data.accent_color !== undefined) { fields.push('accent_color = ?'); values.push(data.accent_color); }
      if (data.locale !== undefined) { fields.push('locale = ?'); values.push(data.locale); }
      if (data.rtl !== undefined) { fields.push('rtl = ?'); values.push(data.rtl ? 1 : 0); }

      await db.execute(
        `INSERT INTO tenant_branding (tenant_id, logo_url, primary_color, secondary_color, accent_color, locale, rtl)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP`,
        [
          tenant.id,
          data.logo_url ?? null,
          data.primary_color ?? null,
          data.secondary_color ?? null,
          data.accent_color ?? null,
          data.locale ?? 'ar',
          data.rtl === undefined ? 1 : (data.rtl ? 1 : 0),
          ...values,
        ],
      );

      const newRow = await db.queryOne<Record<string, unknown>>(
        `SELECT logo_url, primary_color, secondary_color, accent_color, locale, rtl FROM tenant_branding WHERE tenant_id = ? LIMIT 1`,
        [tenant.id],
      );

      const auditFn = deps.audit;
      const runAudit = async () => {
        if (auditFn) {
          await auditFn({
            actorUserId: req.user!.id,
            tenantId: tenant.id,
            action: 'tenant.branding.updated',
            resourceType: 'tenant_branding',
            resourceId: tenant.id,
            oldValue: oldRow ?? null,
            newValue: newRow ?? null,
          });
        } else {
          await recordAudit(db.execute, {
            actorUserId: req.user!.id,
            tenantId: tenant.id,
            action: 'tenant.branding.updated',
            resourceType: 'tenant_branding',
            resourceId: tenant.id,
            oldValue: oldRow ?? null,
            newValue: newRow ?? null,
          });
        }
      };
      try {
        await runAudit();
      } catch (auditError) {
        console.error('Tenant branding audit error:', auditError);
        return res.status(500).json({ error: 'Failed to update branding' });
      }

      return res.json(newRow ?? { tenant_id: tenant.id });
    } catch (error) {
      console.error('Tenant branding update error:', error);
      return res.status(500).json({ error: 'Failed to update branding' });
    }
  };

  router.put(['/', '/branding', '/me'], upsert);
  router.patch(['/', '/branding', '/me'], upsert);

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

export default createTenantBrandingRouter({
  db: { query, queryOne, execute },
  authenticate: authenticateToken,
  loadActiveTenantAuthority,
});
