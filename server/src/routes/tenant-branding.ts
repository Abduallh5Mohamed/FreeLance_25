/**
 * M2-B06 — private localized branding metadata for the VERIFIED institution
 * owner.
 *
 * Contract: docs/streams/server/M2-B06-CONTRACT.md
 * Handoff:  docs/streams/client/M2-12-HANDOFF.md
 *
 * Branding is PRESENTATION METADATA: two localized display labels and one
 * accent color. This module adds no business identity (it never renames
 * `tenants.business_name`), no account, no access, no pricing, no billing, no
 * logo/asset, no host/subdomain/DNS/TLS and no global application language or
 * theme. A saved label changes nothing but what the owner may render.
 *
 * The module is deliberately self-contained:
 *   * it imports `AuthRequest` as a TYPE only, so it pulls in no
 *     authentication, database, provider or environment module at runtime;
 *   * it has no default export and binds no production adapter — the
 *     transactional connection supplier is injected by the caller;
 *   * every statement runs on the injected connection, so the authorization,
 *     the read and the write share ONE database snapshot and ONE transaction.
 *
 * The tenant is never taken from the request: it is the server-selected scope
 * on the authenticated principal and it is re-verified against the real
 * `tenants.owner_user_id` row.
 *
 * Endpoints (mounted by `tenant-self.ts` under `/branding`, i.e.
 * `/api/tenants/me/branding`):
 *   * `GET   /`  — read the effective branding of the selected tenant;
 *   * `PATCH /`  — update a nonempty subset of the three branding fields.
 *
 * Response envelope, in both cases, is EXACTLY:
 *   `{ branding: { display_name_ar, display_name_en, accent_color, updated_at } }`
 * No row is ever spread: `tenant_id`, `created_at` and every owner/contact/
 * billing column stay server-side.
 */
import { randomUUID } from 'crypto';
import { Router, Response } from 'express';
import type { AuthRequest } from '../middleware/auth';

/**
 * Minimal transactional connection seam, structurally identical to the
 * tenant-self / course-unit / course-lesson seams. Production binds a real
 * mysql2 PoolConnection (getPool().getConnection()); hermetic tests bind a
 * fixture-backed connection so the real handler and authorization logic runs
 * without a database, a network or a live app startup.
 */
export interface TenantBrandingConnection {
  beginTransaction(): Promise<void>;
  execute(sql: string, params?: any[]): Promise<[any, any]>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
  /**
   * Discard the physical connection instead of returning it to the shared
   * pool, so an uncertain transaction can never be recycled into a later
   * request.
   */
  destroy(): void;
}

/** The only dependency of this router: a transactional connection supplier. */
export interface TenantBrandingDeps {
  getConnection: () => Promise<TenantBrandingConnection>;
}

/** A display label is a trimmed free label of 1..255 characters. */
const LABEL_MAX = 255;

/**
 * The canonical stored/returned accent color: exactly `#` plus six UPPERCASE
 * hexadecimal digits.
 *
 * The INPUT pattern accepts either case and the handler canonicalizes to
 * uppercase, so one color has exactly ONE stored representation. The canonical
 * pattern is then re-checked on every read, so a row written by any other path
 * (a manual statement, a future migration) can never be served in a
 * non-canonical form.
 */
const ACCENT_INPUT_PATTERN = /^#[0-9a-fA-F]{6}$/;
const ACCENT_CANONICAL_PATTERN = /^#[0-9A-F]{6}$/;

/** The three writable fields, in the documented order. */
const BRANDING_FIELDS: readonly string[] = ['display_name_ar', 'display_name_en', 'accent_color'];

/**
 * Render a stored instant as UTC ISO-8601 from its Unix EPOCH SECONDS.
 *
 * The branding timestamp is read with `UNIX_TIMESTAMP(col)`, never as a driver
 * datetime value. The installed mysql2 pool is configured with
 * `timezone: '+02:00'`, and the driver uses that value to INTERPRET the wall
 * time it receives: it is a client-side conversion, NOT a
 * `SET SESSION time_zone` statement, so it does not configure a SQL session
 * offset. A TIMESTAMP stored as `12:00:00` in a UTC session is therefore
 * decoded by that driver as `10:00Z`, which would shift every serialized
 * instant by the offset of the day. Projecting the stored instant as epoch
 * seconds removes the driver interpretation entirely: the serialized value is
 * the stored instant itself and does not depend on the session time zone, on
 * the driver offset or on a daylight-saving transition.
 *
 * A missing, malformed, non-positive or unrepresentable epoch is REFUSED: no
 * 1970 instant, no "now" and no null date is ever fabricated for a row that
 * exists.
 */
const EPOCH_SECONDS_PATTERN = /^-?\d+(?:\.\d+)?$/;

const toUtcTimestamp = (epochSeconds: unknown): string | null => {
  let epoch: number;
  if (typeof epochSeconds === 'number') {
    epoch = epochSeconds;
  } else if (typeof epochSeconds === 'string') {
    const trimmed = epochSeconds.trim();
    if (!EPOCH_SECONDS_PATTERN.test(trimmed)) return null;
    epoch = Number(trimmed);
  } else {
    return null;
  }
  // Epoch 0 (1970-01-01T00:00:00Z) is not a representable TIMESTAMP instant
  // and is refused with the rest of the malformed values.
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  const instant = new Date(epoch * 1000);
  if (Number.isNaN(instant.getTime())) return null;
  return instant.toISOString();
};

/**
 * The read projection of a branding row.
 *
 * The timestamp is projected as epoch seconds (`UNIX_TIMESTAMP`) so the
 * serialized instant never depends on the driver offset; the raw datetime
 * column is deliberately NOT selected.
 */
const BRANDING_PROJECTION =
  'b.display_name_ar,b.display_name_en,b.accent_color,' +
  'UNIX_TIMESTAMP(b.updated_at) AS updated_at_epoch';

/** A stored nullable label, verbatim: `null` stays `null`, a string is trimmed. */
const storedLabel = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

/**
 * The effective branding of a tenant whose config row is genuinely ABSENT.
 *
 * This is the ONLY way an all-null `updated_at` is produced, and it is only
 * produced when the owner read actually succeeded and the row does not exist.
 * A missing table, a broken statement or any other error is a 500 — an
 * all-null success is never fabricated to hide a broken deployment.
 */
const absentBrandingDto = () => ({
  display_name_ar: null as string | null,
  display_name_en: null as string | null,
  accent_color: null as string | null,
  updated_at: null as string | null,
});

/**
 * Explicit branding DTO built from a STORED row. The row is never spread: only
 * the four documented fields are exposed.
 *
 * A row whose epoch projection cannot be rendered truthfully, or whose stored
 * accent color is not canonical uppercase, yields NO DTO at all: the caller
 * has to fail the request instead of answering with a fabricated instant or a
 * non-canonical color.
 */
const brandingDto = (row: any) => {
  const updatedAt = toUtcTimestamp(row?.updated_at_epoch);
  if (updatedAt === null) return null;
  const accentColor = storedLabel(row?.accent_color);
  if (accentColor !== null && !ACCENT_CANONICAL_PATTERN.test(accentColor)) return null;
  return {
    display_name_ar: storedLabel(row?.display_name_ar),
    display_name_en: storedLabel(row?.display_name_en),
    accent_color: accentColor,
    updated_at: updatedAt,
  };
};

/**
 * The outcome of parsing one writable field.
 *
 * `null` is a legal VALUE ("inherit the existing presentation"), so an invalid
 * input cannot be signalled by returning `null`. The result object keeps
 * "the value is null" and "the value is invalid" distinguishable.
 */
type FieldParseResult = { readonly ok: true; readonly value: string | null } | { readonly ok: false };

/**
 * Strict label parsing: `null` (inherit) or a string that trims to 1..255
 * characters.
 *
 * An empty, whitespace-only, non-string, array, number, boolean or URL value
 * is rejected — never coerced, never stored as `''`. Unicode is permitted and
 * no script or locale is guessed from the field name.
 */
const parseLabel = (raw: unknown): FieldParseResult => {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false };
  const label = raw.trim();
  if (label.length < 1 || label.length > LABEL_MAX) return { ok: false };
  return { ok: true, value: label };
};

/**
 * Strict accent-color parsing: `null` (inherit) or exactly `#RRGGBB`.
 *
 * Either case is accepted and canonicalized to UPPERCASE, so the stored value
 * has one representation. A shorthand (`#abc`), a named color, an `rgb()`/
 * `hsl()` value, a URL, a non-string or a 3/8-digit hex is rejected — the
 * client never gets to store a value that would later be interpreted as raw
 * CSS.
 */
const parseAccentColor = (raw: unknown): FieldParseResult => {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string' || !ACCENT_INPUT_PATTERN.test(raw)) return { ok: false };
  return { ok: true, value: raw.toUpperCase() };
};

export const createTenantBrandingRouter = (deps: TenantBrandingDeps): Router => {
  const router = Router();
  const { getConnection } = deps;

  /**
   * Local billing-only denial.
   *
   * `middleware/auth.ts` exempts the WHOLE /api/tenants/me prefix from the
   * instructor billing-only path restriction, so merely mounting a route below
   * that prefix does NOT enforce the denial. Both branding routes therefore
   * check `req.user.billingOnly` themselves and refuse BEFORE any connection is
   * acquired. The shared authentication middleware and its exemptions are not
   * touched.
   */
  const denyBillingOnly = (req: AuthRequest, res: Response): boolean => {
    if (!req.user?.billingOnly) return false;
    res.status(403).json({
      error: 'Branding management is not available while the account is limited to billing and support',
      code: 'BILLING_ONLY',
    });
    return true;
  };

  /**
   * Verify that the caller is the owner of the SELECTED tenant.
   *
   * The check is resolved from server-side rows only, on the same connection
   * that performs the branding work: the tenant's real `owner_user_id`, its
   * status and the caller's own active user row. A membership role label
   * (`owner`/`instructor`) never grants branding visibility or writes, and a
   * global teacher/admin role is not a tenant owner at all.
   *
   * The owner is determined BEFORE the config row is looked up, so a non-owner
   * learns nothing about whether a branding row exists.
   *
   * `lock` takes the owner row FOR UPDATE. On a write this lock is also the
   * serializer for a FIRST insert: two concurrent first saves for the same
   * tenant contend on this one row, so at most one of them can reach the
   * INSERT. The read path uses a plain snapshot select, so a read never blocks
   * a write and never takes an exclusive lock.
   */
  const verifyTenantOwner = async (
    connection: TenantBrandingConnection,
    userId: string,
    tenantId: string,
    lock: boolean
  ): Promise<any | null> => {
    const [rows] = await connection.execute(
      `SELECT t.owner_user_id,t.status AS tenant_status,u.is_active AS caller_active
       FROM tenants t JOIN users u ON u.id=? WHERE t.id=?${lock ? ' FOR UPDATE' : ''}`,
      [userId, tenantId]
    );
    const row = (rows as any[])[0];
    if (!row || String(row.owner_user_id) !== userId || row.tenant_status !== 'active' || Number(row.caller_active) !== 1) {
      return null;
    }
    return row;
  };

  /**
   * GET /api/tenants/me/branding — the effective branding of the
   * server-selected tenant, for its verified owner.
   *
   * Owner-only and selector-free: no tenant id is accepted from
   * header/query/body, and there is no fallback to an arbitrary membership. A
   * genuinely absent config row answers the all-null DTO with
   * `updated_at: null`; a missing table or any statement error answers 500, so
   * a broken deployment is never disguised as "no branding configured".
   *
   * `Cache-Control: no-store` is set before the first await and before any
   * denial, so every outcome this handler produces — 200, own 404, own 403 and
   * the 500 paths — carries it.
   */
  router.get('/', async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    if (denyBillingOnly(req, res)) return;

    const userId = req.user?.id;
    const tenantId = req.user?.tenantId;
    if (!userId || !tenantId) return res.status(404).json({ error: 'Tenant membership not found' });

    let connection: TenantBrandingConnection | null = null;
    let transactionStarted = false;
    let disposal: 'release' | 'destroy' = 'release';

    const rollbackOrDiscard = async (): Promise<boolean> => {
      try {
        await connection!.rollback();
        return true;
      } catch (rollbackError) {
        disposal = 'destroy';
        console.error('Rollback tenant branding read error (connection will be discarded):', rollbackError);
        return false;
      }
    };

    try {
      connection = await getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      // The owner is determined BEFORE the config row is looked up, so a
      // non-owner learns nothing about whether a branding row exists.
      const owner = await verifyTenantOwner(connection, userId, tenantId, false);
      if (!owner) {
        await rollbackOrDiscard();
        return res.status(403).json({ error: 'Forbidden' });
      }
      const [rows] = await connection.execute(
        `SELECT ${BRANDING_PROJECTION} FROM tenant_branding b WHERE b.tenant_id=? LIMIT 1`,
        [tenantId]
      );
      const stored = (rows as any[])[0] ?? null;
      const dto = stored === null ? absentBrandingDto() : brandingDto(stored);
      if (dto === null) {
        // A stored row whose instant or color cannot be rendered truthfully is
        // a failure, never an all-null success and never a guessed value.
        console.error('Get tenant branding error: unreadable branding projection');
        await rollbackOrDiscard();
        return res.status(500).json({ error: 'Failed to load branding' });
      }
      // A read transaction is closed, never committed: nothing was written.
      await rollbackOrDiscard();
      return res.json({ branding: dto });
    } catch (error) {
      if (transactionStarted) {
        console.error('Get tenant branding error:', error);
        await rollbackOrDiscard();
      } else {
        // The connection exists but its transaction state is not confirmed.
        // Discard rather than pooling a possibly-dirty session.
        disposal = 'destroy';
        console.error('Get tenant branding error before transaction start:', error);
      }
      return res.status(500).json({ error: 'Failed to load branding' });
    } finally {
      if (connection) {
        if (disposal === 'destroy') {
          try { connection.destroy(); } catch { /* connection already gone */ }
        } else {
          try { connection.release(); } catch { /* connection already released */ }
        }
      }
    }
  });

  /**
   * PATCH /api/tenants/me/branding — update a nonempty subset of the three
   * branding fields for the verified owner of the selected tenant.
   *
   * Strict: the body must be a plain object carrying only `display_name_ar`,
   * `display_name_en` and/or `accent_color`. An empty object, an unknown key
   * (a tenant/owner/identity selector, a logo, a theme or a language field), a
   * non-null non-string value, an empty or whitespace-only label, a label over
   * 255 characters, an array, a number or a non-`#RRGGBB` color is rejected
   * BEFORE any connection is acquired.
   *
   * `null` is a real value meaning "inherit the existing presentation" — it is
   * never the empty string and never a fabricated default.
   *
   * No-op semantics: when the requested EFFECTIVE values equal the current
   * effective values, nothing is written, nothing is audited and nothing is
   * committed; the truthful canonical DTO of the current state is returned. An
   * absent row with an all-null requested effective config is exactly such a
   * no-op and the row STAYS absent. An absent row with a real change inserts
   * the complete effective row, with every field the request did not mention
   * stored as NULL.
   *
   * Atomicity: the owner check, the config lock, the insert/update, exactly ONE
   * bounded audit event, the read-back and the DTO materialization all share
   * ONE transaction. The DTO is materialized BEFORE the single commit, so an
   * unreadable stored instant fails the write instead of committing a row whose
   * date could only be guessed. Success is reported only after `commit()`
   * resolves.
   *
   * Disposal: a confirmed rollback (or a committed transaction) releases the
   * connection exactly once; a failed rollback, a failure before the
   * transaction state is confirmed, or a lost commit acknowledgement destroys
   * it instead, so it can never re-enter the shared pool with an open
   * transaction. A lost commit acknowledgement is reported as a 500 and no
   * rollback, idempotence or retry is claimed.
   *
   * This handler makes NO lost-update-prevention, version or CAS promise. The
   * only serialization is the row lock taken above, inside this transaction.
   */
  router.patch('/', async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    if (denyBillingOnly(req, res)) return;

    const invalid = () => res.status(400).json({ error: 'Invalid branding payload' });

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid();
    const keys = Object.keys(body);
    if (keys.length === 0) return invalid();
    for (const key of keys) {
      if (!BRANDING_FIELDS.includes(key)) return invalid();
    }

    const record = body as Record<string, unknown>;
    const hasAr = Object.prototype.hasOwnProperty.call(record, 'display_name_ar');
    const hasEn = Object.prototype.hasOwnProperty.call(record, 'display_name_en');
    const hasAccent = Object.prototype.hasOwnProperty.call(record, 'accent_color');

    let nextAr: string | null = null;
    if (hasAr) {
      const parsed = parseLabel(record.display_name_ar);
      if (!parsed.ok) return invalid();
      nextAr = parsed.value;
    }
    let nextEn: string | null = null;
    if (hasEn) {
      const parsed = parseLabel(record.display_name_en);
      if (!parsed.ok) return invalid();
      nextEn = parsed.value;
    }
    let nextAccent: string | null = null;
    if (hasAccent) {
      const parsed = parseAccentColor(record.accent_color);
      if (!parsed.ok) return invalid();
      nextAccent = parsed.value;
    }

    const userId = req.user?.id;
    const tenantId = req.user?.tenantId;
    if (!userId || !tenantId) return res.status(404).json({ error: 'Tenant membership not found' });

    // The connection is tracked explicitly: a failed acquisition has nothing to
    // clean up, while an uncertain transaction must be destroyed rather than
    // returned to the shared pool.
    let connection: TenantBrandingConnection | null = null;
    let transactionStarted = false;
    let commitAttempted = false;
    let disposal: 'release' | 'destroy' = 'release';

    const rollbackOrDiscard = async (): Promise<boolean> => {
      try {
        await connection!.rollback();
        return true;
      } catch (rollbackError) {
        disposal = 'destroy';
        console.error('Rollback tenant branding update error (connection will be discarded):', rollbackError);
        return false;
      }
    };

    try {
      connection = await getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      // The owner is determined BEFORE the config row is looked up, so a
      // non-owner learns nothing about whether a branding row exists. The
      // FOR UPDATE lock on the owner row is also what serializes two
      // concurrent FIRST inserts for this tenant.
      const owner = await verifyTenantOwner(connection, userId, tenantId, true);
      if (!owner) {
        await rollbackOrDiscard();
        return res.status(403).json({ error: 'Forbidden' });
      }
      // The existing config row is locked for the write, so a concurrent save
      // cannot interleave between this read and the statement below.
      const [rows] = await connection.execute(
        `SELECT ${BRANDING_PROJECTION} FROM tenant_branding b WHERE b.tenant_id=? FOR UPDATE`,
        [tenantId]
      );
      const current = (rows as any[])[0] ?? null;

      const currentAr = current === null ? null : storedLabel(current.display_name_ar);
      const currentEn = current === null ? null : storedLabel(current.display_name_en);
      const currentAccent = current === null ? null : storedLabel(current.accent_color);
      // A row stored by another path with a non-canonical color cannot be
      // compared or re-served truthfully: fail instead of guessing.
      if (currentAccent !== null && !ACCENT_CANONICAL_PATTERN.test(currentAccent)) {
        console.error('Update tenant branding error: non-canonical stored accent color');
        await rollbackOrDiscard();
        return res.status(500).json({ error: 'Failed to update branding' });
      }

      // The EFFECTIVE next config: a field the request did not mention keeps
      // its current value (which is `null` when the row is absent).
      const finalAr = hasAr ? nextAr : currentAr;
      const finalEn = hasEn ? nextEn : currentEn;
      const finalAccent = hasAccent ? nextAccent : currentAccent;

      const unchanged =
        finalAr === currentAr && finalEn === currentEn && finalAccent === currentAccent;
      if (unchanged) {
        // Truthful no-op: no UPDATE, no INSERT, no audit event, no commit. The
        // response is the canonical current state — which is the all-null DTO
        // when the row is absent, and the row stays absent.
        if (current === null) {
          await rollbackOrDiscard();
          return res.json({ branding: absentBrandingDto() });
        }
        const currentDto = brandingDto(current);
        if (currentDto === null) {
          console.error('Update tenant branding error: unreadable branding projection');
          await rollbackOrDiscard();
          return res.status(500).json({ error: 'Failed to update branding' });
        }
        await rollbackOrDiscard();
        return res.json({ branding: currentDto });
      }

      if (current === null) {
        // First save for this tenant: the complete effective row is inserted,
        // with every unmentioned field stored as NULL ("inherit").
        await connection.execute(
          'INSERT INTO tenant_branding (tenant_id,display_name_ar,display_name_en,accent_color) VALUES (?,?,?,?)',
          [tenantId, finalAr, finalEn, finalAccent]
        );
      } else {
        await connection.execute(
          'UPDATE tenant_branding SET display_name_ar=?,display_name_en=?,accent_color=? WHERE tenant_id=?',
          [finalAr, finalEn, finalAccent, tenantId]
        );
      }

      // Exactly ONE bounded audit event for the effective change. It carries
      // the three branding fields only — never a credential, a student, a
      // billing or a business-identity field.
      await connection.execute(
        `INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value)
         VALUES (?,?,?,?,?,?,?,?)`,
        [randomUUID(), userId, tenantId, 'tenant.branding_updated', 'tenant_branding', tenantId,
          JSON.stringify({ display_name_ar: currentAr, display_name_en: currentEn, accent_color: currentAccent }),
          JSON.stringify({ display_name_ar: finalAr, display_name_en: finalEn, accent_color: finalAccent })]
      );

      // The row is read back inside the same transaction so the response
      // carries the exact stored instant instead of a guessed one.
      const [readBack] = await connection.execute(
        `SELECT ${BRANDING_PROJECTION} FROM tenant_branding b WHERE b.tenant_id=? LIMIT 1`,
        [tenantId]
      );
      const stored = (readBack as any[])[0] ?? null;
      if (stored === null) {
        console.error('Update tenant branding error: branding row missing after write');
        await rollbackOrDiscard();
        return res.status(500).json({ error: 'Failed to update branding' });
      }
      const dto = brandingDto(stored);
      if (dto === null) {
        console.error('Update tenant branding error: unreadable branding projection');
        await rollbackOrDiscard();
        return res.status(500).json({ error: 'Failed to update branding' });
      }
      // The read-back is the transaction's own view of what it wrote. A
      // mismatch is an internal consistency failure, not a product conflict:
      // it is never reported as success and never invents a retry policy.
      if (
        dto.display_name_ar !== finalAr ||
        dto.display_name_en !== finalEn ||
        dto.accent_color !== finalAccent
      ) {
        console.error('Update tenant branding error: read-back does not match the requested effective config');
        await rollbackOrDiscard();
        return res.status(500).json({ error: 'Failed to update branding' });
      }
      commitAttempted = true;
      await connection.commit();
      return res.json({ branding: dto });
    } catch (error) {
      if (commitAttempted) {
        // The commit acknowledgement was lost: whether the write persisted is
        // UNKNOWN. Do not claim a rollback happened, do not retry silently, and
        // never return this connection to the pool.
        disposal = 'destroy';
        console.error('Update tenant branding error after commit attempt (persistence uncertain):', error);
      } else if (transactionStarted) {
        console.error('Update tenant branding error:', error);
        await rollbackOrDiscard();
      } else {
        // The connection was obtained but `beginTransaction` failed, so the
        // server-side transaction state is not confirmed. Discard rather than
        // pooling a possibly-dirty session. Acquisition failure skips cleanup
        // entirely because no connection exists.
        disposal = 'destroy';
        console.error('Update tenant branding error before transaction start:', error);
      }
      return res.status(500).json({ error: 'Failed to update branding' });
    } finally {
      if (connection) {
        if (disposal === 'destroy') {
          try { connection.destroy(); } catch { /* connection already gone */ }
        } else {
          try { connection.release(); } catch { /* connection already released */ }
        }
      }
    }
  });

  return router;
};
