/**
 * M2-12 — private tenant branding controls on the existing instructor
 * dashboard.
 *
 * The production seam the dashboard mounts through
 * `src/features/tenant/TenantBrandingCard.tsx`: this module owns the WHOLE
 * request and form lifecycle (explicit panel open, one owner read, the local
 * draft, local validation, the dirty-subset save, runtime DTO validation,
 * uncertain-write handling, stale-reply invalidation, session and disposal
 * fences, and the UNSAVED local preview) and keeps React rendering out of the
 * decision path.
 *
 * The transport, the principal reader and the session notifier are injected, so
 * the exact production code the dashboard runs is exercised hermetically in
 * node:test (src/tests/m2-tenant-branding-ui.test.ts) with no DB, no network,
 * no browser and no live app.
 *
 * Contracts verified from source (docs/streams/server/M2-B06-CONTRACT.md):
 *  - `GET /api/tenants/me/branding` answers exactly
 *    `{ branding: { display_name_ar, display_name_en, accent_color, updated_at } }`;
 *    the row is never spread and `tenant_id` is never exposed;
 *  - a label is `null` (inherit) or a trimmed 1..255 string; `accent_color` is
 *    `null` (inherit) or exactly `#RRGGBB` canonical UPPERCASE;
 *  - `updated_at` is a canonical ISO instant, or `null` ONLY for a successful
 *    owner read of a genuinely absent config row — so a `null` instant with a
 *    non-null field is a CONTRADICTION and is refused here;
 *  - `PATCH /api/tenants/me/branding` takes a nonempty subset of the three
 *    fields; `null` is a real value meaning "inherit", never the empty string;
 *  - the routes are owner-only, resolved from server-side rows: a membership
 *    role label never grants access and a membership instructor gets 403
 *    `Forbidden`;
 *  - the local billing-only guard answers 403 with the branding-specific
 *    `Branding management is not available while the account is limited to
 *    billing and support` (code `BILLING_ONLY`) — the shared transport keeps its
 *    canonical identity event and redirect untouched;
 *  - the documented failures are 400 `Invalid branding payload`, 404
 *    `Tenant membership not found`, 500 `Failed to load branding` /
 *    `Failed to update branding`, plus the unchanged upstream 401/suspension
 *    answers;
 *  - the shared transport throws the server's `error` message WITHOUT the HTTP
 *    status and WITHOUT the `code`, so ONLY the documented messages classify an
 *    outcome — no status is ever fabricated and a discarded code is never turned
 *    into a permission outcome;
 *  - the accepted migration FILE is NOT applied: a real deployment answers with
 *    a truthful 500 and no client-side fallback data is invented.
 *
 * Lifetimes fenced here:
 *  - read: every read advances a read generation, so a superseded reply can
 *    never commit;
 *  - request: every save advances its own request generation and takes a
 *    synchronous single-flight latch BEFORE the first await, so a double click
 *    or Enter never sends a second write;
 *  - visible mutation: the save that owns the visible mutation owns its
 *    status, error and notice, so a RETIRED reply can never settle a newer
 *    operation's mutation, error, notice or form;
 *  - form: opening, cancelling or invalidating a form advances the form
 *    generation, so a late reply never rewrites or closes a newer form;
 *  - authorization: a DEFINITE read authorization or tenant scope loss clears
 *    the confirmed branding, the drafts, the notice and the preview and retires
 *    every in-flight operation. A retryable read failure keeps the draft,
 *    because no permission loss was proven;
 *  - session: the canonical principal is re-read at entry AND at completion of
 *    every read and write (success and failure), and a RETIRED operation
 *    observes it BEFORE it settles any visible state;
 *  - close/dispose: the panel clears the confirmed branding, the drafts and the
 *    preview and drops every in-flight reply.
 *
 * Honesty rules that are part of the contract:
 *  - a 2xx body that cannot be validated is NOT a success;
 *  - a 500/network/malformed write outcome is UNCERTAIN: the save may have
 *    persisted, nothing is retried automatically, the draft is preserved and a
 *    deliberate read is offered. The read shows the CURRENT server state — it is
 *    never proof of the earlier save or of its audit event;
 *  - a confirmed success uses the validated server DTO only;
 *  - a save with no effective change sends NO request at all.
 *
 * Out of scope by construction: no new route, no schema application, no logo/
 * background/upload, no host/subdomain/DNS/TLS, no global theme or language
 * provider, no localStorage/sessionStorage/IndexedDB/clipboard, and no branding
 * capability inferred from a local role, profile or status.
 */
import type { TenantBranding, TenantBrandingEnvelope } from '../../lib/api-http';
import { createCourseOperationGuard, createTicketSource } from '../catalog/course-management';

/**
 * The canonical session reader the dashboard uses. Re-exported so the page
 * imports ONE principal boundary: M2-02's reader holds the single canonical
 * localStorage lifetime, and a second parallel lifetime here would let the two
 * panels disagree about what "the same session" means.
 */
export { readCourseSessionPrincipal } from '../catalog/course-management';
export type { CourseSessionStorage } from '../catalog/course-management';

// ---------------------------------------------------------------------------
// Failure classification — documented transported messages only
// ---------------------------------------------------------------------------

/** The page's own wording for a body that is not the documented envelope. The
 *  server never sends this string, so it can never be confused with a server
 *  classification. */
export const MALFORMED_BRANDING_MESSAGE = 'استجابة غير صالحة من الخادم';

/** Local validation wording: the input never reaches the transport. */
export const BRANDING_LABEL_INVALID_MESSAGE =
  'اسم العرض يجب أن يكون بين 1 و255 حرفًا بعد إزالة المسافات، أو اختيار «موروث».';

export const BRANDING_COLOR_INVALID_MESSAGE =
  'اللون يجب أن يكون بصيغة #RRGGBB، أو اختيار «موروث».';

/** Local wording when the form carries no effective change: no request is sent. */
export const BRANDING_NO_CHANGES_MESSAGE = 'لا توجد تغييرات لحفظها.';

/** Local warning after a reply that may or may not have persisted server-side. */
export const BRANDING_WRITE_UNCERTAIN_MESSAGE =
  'لم يتم تأكيد حفظ الهوية. قد تكون التغييرات قد حُفظت على الخادم؛ اقرأ الحالة الحالية للمطابقة. لن تُعاد المحاولة تلقائيًا.';

/** Local wording after the deliberate read-only reconciliation. The values
 *  shown are the CURRENT server state, never proof of the previous save. */
export const BRANDING_RECONCILED_MESSAGE =
  'تم عرض الحالة الحالية من الخادم. هذا لا يؤكد نجاح محاولة الحفظ السابقة.';

/** Upstream authentication answers — the EXACT messages the shared transport
 *  throws (server/src/middleware/auth.ts). The transport discards the HTTP
 *  status and the `code` field, so the classifier matches the transported
 *  `error` string, never a synthetic code. */
const SESSION_INVALID_MESSAGES = new Set<string>([
  'Token expired',
  'Invalid token',
  'No token provided',
  'Session revoked',
  'Selected workspace is no longer active',
]);

/** The account is administratively suspended: the shared transport also tears
 *  the session down; the feature records the denial it can see. */
const SUSPENDED_MESSAGE = 'Instructor account is administratively suspended';

/** No authorized workspace: the handler's 404 and the student-boundary 409. */
const NO_WORKSPACE_MESSAGES = new Set<string>([
  'Tenant membership not found',
  'Select an instructor workspace first',
]);

/** The accepted branding-local billing-only denial (M2-B06 contract). */
const BILLING_ONLY_MESSAGE =
  'Branding management is not available while the account is limited to billing and support';

/** The owner-only denial for a membership instructor (M2-B06 contract). */
const FORBIDDEN_MESSAGE = 'Forbidden';

/** The accepted handler 500 wordings. */
const BRANDING_LOAD_FAILED_MESSAGE = 'Failed to load branding';
const BRANDING_UPDATE_FAILED_MESSAGE = 'Failed to update branding';

/** The handler's strict payload rejection: no connection was taken. */
const BRANDING_INVALID_PAYLOAD_MESSAGE = 'Invalid branding payload';

export type TenantBrandingPhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'error'
  | 'unauthorized'
  | 'denied'
  | 'no-workspace';

/** Why an outcome was classified. Every value comes from a documented
 *  transported message; nothing is guessed from a discarded code. */
export type TenantBrandingFailureReason =
  | 'session'
  | 'suspended'
  | 'billing-only'
  | 'not-owner'
  | 'no-workspace'
  | 'invalid'
  | 'server'
  | 'unknown';

export interface TenantBrandingFailure {
  readonly phase: TenantBrandingPhase;
  readonly reason: TenantBrandingFailureReason;
  readonly message: string;
}

/**
 * Classifies ONLY the documented transported messages of a READ. A permission
 * outcome is never faked from an unrecognized message: it stays a retryable
 * read error with its actual message on screen.
 */
export function classifyTenantBrandingFailure(cause: unknown): TenantBrandingFailure {
  const message = cause instanceof Error ? cause.message : String(cause ?? '');
  if (SESSION_INVALID_MESSAGES.has(message)) {
    return { phase: 'unauthorized', reason: 'session', message };
  }
  if (message === SUSPENDED_MESSAGE) {
    return { phase: 'denied', reason: 'suspended', message };
  }
  if (message === BILLING_ONLY_MESSAGE) {
    return { phase: 'denied', reason: 'billing-only', message };
  }
  if (message === FORBIDDEN_MESSAGE) {
    return { phase: 'denied', reason: 'not-owner', message };
  }
  if (NO_WORKSPACE_MESSAGES.has(message)) {
    return { phase: 'no-workspace', reason: 'no-workspace', message };
  }
  if (message === BRANDING_LOAD_FAILED_MESSAGE) {
    return { phase: 'error', reason: 'server', message };
  }
  return {
    phase: 'error',
    reason: 'unknown',
    message: message || 'فشل تحميل هوية المساحة',
  };
}

export type TenantBrandingWriteKind =
  | 'unauthorized'
  | 'denied'
  | 'invalid'
  | 'uncertain';

/**
 * A DEFINITE loss of the read authorization or of the tenant scope.
 *
 * Only the documented denial answers qualify: an expired or invalid session, an
 * administratively suspended account, the billing-only restriction, the
 * owner-only denial and a missing workspace. A retryable read failure does NOT
 * prove a permission loss, so it keeps the draft.
 */
export function isTenantBrandingAuthorizationLoss(reason: TenantBrandingFailureReason): boolean {
  return (
    reason === 'session' ||
    reason === 'suspended' ||
    reason === 'billing-only' ||
    reason === 'not-owner' ||
    reason === 'no-workspace'
  );
}

export interface TenantBrandingWriteFailure {
  readonly kind: TenantBrandingWriteKind;
  readonly reason: TenantBrandingFailureReason;
  readonly message: string;
}

/**
 * Classifies ONLY the documented transported messages of a WRITE.
 *
 * `uncertain` covers the handler 500 (the client cannot distinguish a confirmed
 * rollback from a lost commit acknowledgement) and every unrecognized/network/
 * transport failure after the request was sent: the save MAY have persisted, so
 * nothing is retried automatically.
 */
export function classifyTenantBrandingWriteFailure(cause: unknown): TenantBrandingWriteFailure {
  const message = cause instanceof Error ? cause.message : String(cause ?? '');
  if (SESSION_INVALID_MESSAGES.has(message)) {
    return { kind: 'unauthorized', reason: 'session', message };
  }
  if (message === SUSPENDED_MESSAGE) {
    return { kind: 'unauthorized', reason: 'suspended', message };
  }
  if (message === BILLING_ONLY_MESSAGE) {
    return { kind: 'denied', reason: 'billing-only', message };
  }
  if (message === FORBIDDEN_MESSAGE) {
    return { kind: 'denied', reason: 'not-owner', message };
  }
  if (NO_WORKSPACE_MESSAGES.has(message)) {
    return { kind: 'denied', reason: 'no-workspace', message };
  }
  if (message === BRANDING_INVALID_PAYLOAD_MESSAGE) {
    return { kind: 'invalid', reason: 'invalid', message };
  }
  if (message === BRANDING_UPDATE_FAILED_MESSAGE) {
    return { kind: 'uncertain', reason: 'server', message };
  }
  return {
    kind: 'uncertain',
    reason: 'unknown',
    message: message || 'فشل غير مؤكد أثناء حفظ هوية المساحة',
  };
}

// ---------------------------------------------------------------------------
// Runtime DTO validation — a missing or malformed body is never a success
// ---------------------------------------------------------------------------

/** The exact four server-projected fields, sorted for an exact key check. */
const BRANDING_KEYS = ['accent_color', 'display_name_ar', 'display_name_en', 'updated_at'];

/** The canonical stored accent color: `#` plus six UPPERCASE hex digits. */
const ACCENT_CANONICAL_PATTERN = /^#[0-9A-F]{6}$/;

/** The canonical instant the server emits from its epoch projection. */
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Validates one nullable label: `null`, or a CANONICAL trimmed 1..255 string.
 *
 * The server trims every label it stores, so a value that is not ALREADY
 * trimmed is a MALFORMED server DTO, never a value this client may normalize:
 * a malformed 2xx body must never be turned into a confirmed success. The
 * length is therefore measured on the canonical (trimmed) value itself.
 *
 * Returns `undefined` when the value is INVALID, so "invalid" is
 * distinguishable from the legal `null` value.
 */
const validateLabel = (value: unknown): string | null | undefined => {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  if (value !== value.trim()) return undefined;
  if (value.length < 1 || value.length > 255) return undefined;
  return value;
};

export type TenantBrandingParseResult =
  | { readonly ok: true; readonly branding: TenantBranding }
  | { readonly ok: false };

/**
 * Validates one branding DTO against the accepted M2-B06 contract: a non-null
 * object whose key set is EXACTLY the four projected fields, whose two labels
 * are `null` or an ALREADY TRIMMED 1..255 string, whose color is `null` or
 * exactly `#RRGGBB` canonical UPPERCASE, and whose `updated_at` is `null` or a
 * finite canonical ISO instant that re-serializes to the very same string.
 *
 * A label that is not already trimmed and an instant whose calendar date is
 * impossible are MALFORMED server DTOs: the server trims every label and
 * projects a real epoch, so this client refuses them instead of normalizing
 * them into a confirmed success.
 *
 * `updated_at: null` is legal ONLY for a genuinely absent config row, so it is
 * accepted only when ALL THREE fields are also null. A null instant next to a
 * non-null field is a CONTRADICTION — the row cannot both exist and not exist —
 * and is refused rather than rendered.
 */
export function parseTenantBranding(body: unknown): TenantBrandingParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false };
  }
  const row = body as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (keys.length !== BRANDING_KEYS.length) return { ok: false };
  for (let index = 0; index < BRANDING_KEYS.length; index += 1) {
    if (keys[index] !== BRANDING_KEYS[index]) return { ok: false };
  }

  const displayNameAr = row.display_name_ar;
  const displayNameEn = row.display_name_en;
  const accentColor = row.accent_color;
  const updatedAt = row.updated_at;

  // Each field is validated into its TYPED form as it is checked, so the DTO is
  // built from values that already passed their own rule.
  const labelAr = validateLabel(displayNameAr);
  if (labelAr === undefined) return { ok: false };
  const labelEn = validateLabel(displayNameEn);
  if (labelEn === undefined) return { ok: false };

  let accent: string | null = null;
  if (accentColor !== null) {
    if (typeof accentColor !== 'string' || !ACCENT_CANONICAL_PATTERN.test(accentColor)) return { ok: false };
    accent = accentColor;
  }

  let instant: string | null = null;
  if (updatedAt !== null) {
    if (typeof updatedAt !== 'string' || !ISO_INSTANT_PATTERN.test(updatedAt)) return { ok: false };
    const parsedInstant = new Date(updatedAt);
    if (Number.isNaN(parsedInstant.getTime())) return { ok: false };
    // EXACT canonical round trip. JavaScript silently NORMALIZES a calendar
    // impossible date (2026-02-30 becomes 2026-03-02), so a pattern match
    // alone would accept an instant the server can never have emitted. The
    // instant must re-serialize to the very same canonical string.
    if (parsedInstant.toISOString() !== updatedAt) return { ok: false };
    instant = updatedAt;
  }

  if (instant === null) {
    // Only the genuinely-absent row may carry a null instant.
    if (labelAr !== null || labelEn !== null || accent !== null) return { ok: false };
  }

  return {
    ok: true,
    branding: {
      display_name_ar: labelAr,
      display_name_en: labelEn,
      accent_color: accent,
      updated_at: instant,
    },
  };
}

export type TenantBrandingEnvelopeParseResult =
  | { readonly ok: true; readonly branding: TenantBranding }
  | { readonly ok: false };

/** Validates the `{ branding }` envelope of a read or a confirmed save. */
export function parseTenantBrandingEnvelope(body: unknown): TenantBrandingEnvelopeParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false };
  }
  const envelope = body as Record<string, unknown>;
  const keys = Object.keys(envelope).sort();
  if (keys.length !== 1 || keys[0] !== 'branding') return { ok: false };
  return parseTenantBranding(envelope.branding);
}

// ---------------------------------------------------------------------------
// Form model — local drafts with explicit inherit controls
// ---------------------------------------------------------------------------

export type TenantBrandingField = 'display_name_ar' | 'display_name_en' | 'accent_color';

/**
 * One field draft.
 *
 * `inherit` is the user's explicit choice of the `null` ("inherit the existing
 * presentation") value. When it is true, `text` is retained but NOT effective —
 * so toggling inherit off restores what the user had typed instead of losing it.
 */
export interface TenantBrandingFieldDraft {
  inherit: boolean;
  text: string;
}

export type TenantBrandingFormMode = 'closed' | 'editing';

export interface TenantBrandingFormState {
  mode: TenantBrandingFormMode;
  display_name_ar: TenantBrandingFieldDraft;
  display_name_en: TenantBrandingFieldDraft;
  accent_color: TenantBrandingFieldDraft;
  /** The server-confirmed effective values the form was opened with. */
  originalAr: string | null;
  originalEn: string | null;
  originalAccent: string | null;
  error: string | null;
  notice: string | null;
}

export type TenantBrandingMutationStatus = 'idle' | 'saving' | 'uncertain';

export interface TenantBrandingMutationState {
  status: TenantBrandingMutationStatus;
  /** The actual transported failure message, or local validation wording. */
  error: string | null;
  /** Warning after an uncertain save or a reconciliation read. Never success. */
  notice: string | null;
}

export type TenantBrandingLocale = 'ar' | 'en';

export interface TenantBrandingState {
  /** The panel was explicitly opened by the user. No request happens before. */
  open: boolean;
  phase: TenantBrandingPhase;
  /** The server-confirmed branding, or null before the first read. */
  branding: TenantBranding | null;
  error: string | null;
  /** Why the current phase was reached, when a failure caused it. */
  reason: TenantBrandingFailureReason | null;
  /** The server-confirmed result of the last confirmed save. */
  lastConfirmed: TenantBranding | null;
  form: TenantBrandingFormState;
  mutation: TenantBrandingMutationState;
  /** The locale the LOCAL preview renders. Never a global application setting. */
  previewLocale: TenantBrandingLocale;
}

const closedForm = (): TenantBrandingFormState => ({
  mode: 'closed',
  display_name_ar: { inherit: true, text: '' },
  display_name_en: { inherit: true, text: '' },
  accent_color: { inherit: true, text: '' },
  originalAr: null,
  originalEn: null,
  originalAccent: null,
  error: null,
  notice: null,
});

const idleMutation = (): TenantBrandingMutationState => ({
  status: 'idle',
  error: null,
  notice: null,
});

const initialState: TenantBrandingState = {
  open: false,
  phase: 'idle',
  branding: null,
  error: null,
  reason: null,
  lastConfirmed: null,
  form: closedForm(),
  mutation: idleMutation(),
  previewLocale: 'ar',
};

// ---------------------------------------------------------------------------
// Pure helpers — dirty subset, validation, preview
// ---------------------------------------------------------------------------

/** The effective value of one draft: `null` when the user chose inherit. */
export function effectiveFieldValue(draft: TenantBrandingFieldDraft): string | null {
  if (draft.inherit) return null;
  const trimmed = draft.text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The effective accent color of a draft, canonicalized to UPPERCASE, or `null`.
 *
 * Returns `undefined` when the text is not a valid `#RRGGBB`, so "invalid" is
 * distinguishable from "inherit".
 */
export function effectiveAccentColor(draft: TenantBrandingFieldDraft): string | null | undefined {
  if (draft.inherit) return null;
  const trimmed = draft.text.trim();
  if (trimmed.length === 0) return undefined;
  if (!/^#[0-9a-fA-F]{6}$/.test(trimmed)) return undefined;
  return trimmed.toUpperCase();
}

export type TenantBrandingDraftValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/** Validates the drafts locally, BEFORE any request leaves the page. */
export function validateTenantBrandingDraft(form: TenantBrandingFormState): TenantBrandingDraftValidation {
  for (const field of ['display_name_ar', 'display_name_en'] as const) {
    const draft = form[field];
    if (draft.inherit) continue;
    const trimmed = draft.text.trim();
    if (trimmed.length < 1 || trimmed.length > 255) {
      return { ok: false, message: BRANDING_LABEL_INVALID_MESSAGE };
    }
  }
  if (effectiveAccentColor(form.accent_color) === undefined) {
    return { ok: false, message: BRANDING_COLOR_INVALID_MESSAGE };
  }
  return { ok: true };
}

export interface TenantBrandingPatch {
  display_name_ar?: string | null;
  display_name_en?: string | null;
  accent_color?: string | null;
}

export type TenantBrandingPatchResult =
  | { readonly ok: true; readonly patch: TenantBrandingPatch; readonly dirtyCount: number }
  | { readonly ok: false; readonly message: string };

/**
 * The DIRTY SUBSET only: a field is sent only when its effective value differs
 * from the value the form was opened with.
 *
 * `dirtyCount === 0` means there is nothing to save, so the caller sends NO
 * request at all. An untouched field is never transmitted, so a partial save can
 * never silently clear a value the user did not edit.
 */
export function buildTenantBrandingPatch(form: TenantBrandingFormState): TenantBrandingPatchResult {
  const validation = validateTenantBrandingDraft(form);
  // `strict: false` widens `ok: true | false` to `boolean`, so the union is
  // discriminated by the presence of the failure-only field instead.
  if ('message' in validation) return { ok: false, message: validation.message };

  const patch: TenantBrandingPatch = {};
  let dirtyCount = 0;

  const ar = effectiveFieldValue(form.display_name_ar);
  if (ar !== form.originalAr) { patch.display_name_ar = ar; dirtyCount += 1; }

  const en = effectiveFieldValue(form.display_name_en);
  if (en !== form.originalEn) { patch.display_name_en = en; dirtyCount += 1; }

  const accent = effectiveAccentColor(form.accent_color);
  if (accent === undefined) return { ok: false, message: BRANDING_COLOR_INVALID_MESSAGE };
  if (accent !== form.originalAccent) { patch.accent_color = accent; dirtyCount += 1; }

  return { ok: true, patch, dirtyCount };
}

export interface TenantBrandingPreview {
  readonly locale: TenantBrandingLocale;
  /** The label this locale would render, or `null` when nothing is set. */
  readonly displayName: string | null;
  /** The accent color to apply, or `null` when the presentation is inherited. */
  readonly accentColor: string | null;
  /** True when the preview shows LOCAL UNSAVED values. */
  readonly unsaved: boolean;
  /** True when this locale's label is inherited (no stored value). */
  readonly inherited: boolean;
}

/**
 * Builds the LOCAL preview.
 *
 * The preview NEVER changes the application's language, theme or provider: it
 * renders one label slot and one accent color inside the card. When the form is
 * closed the confirmed values are previewed; while the form is open the LOCAL
 * UNSAVED drafts are previewed and `unsaved` says so.
 *
 * The accent color is only ever non-null after strict `#RRGGBB` validation, so
 * it can never become raw CSS, a URL or markup.
 */
export function buildTenantBrandingPreview(state: TenantBrandingState): TenantBrandingPreview {
  const { form, branding, previewLocale } = state;
  const field = previewLocale === 'ar' ? 'display_name_ar' : 'display_name_en';

  if (form.mode === 'editing') {
    const draft = form[field];
    const label = effectiveFieldValue(draft);
    const accent = effectiveAccentColor(form.accent_color);
    const ar = effectiveFieldValue(form.display_name_ar);
    const en = effectiveFieldValue(form.display_name_en);
    const unsaved =
      ar !== form.originalAr || en !== form.originalEn || accent !== form.originalAccent;
    return {
      locale: previewLocale,
      displayName: label,
      accentColor: accent === undefined ? null : accent,
      unsaved,
      inherited: label === null,
    };
  }

  const stored = branding?.[field] ?? null;
  const storedAccent = branding?.accent_color ?? null;
  return {
    locale: previewLocale,
    displayName: stored,
    accentColor: storedAccent !== null && ACCENT_CANONICAL_PATTERN.test(storedAccent) ? storedAccent : null,
    unsaved: false,
    inherited: stored === null,
  };
}

/** True when the DTO describes a genuinely absent config row. */
export const isAbsentBranding = (branding: TenantBranding): boolean =>
  branding.updated_at === null &&
  branding.display_name_ar === null &&
  branding.display_name_en === null &&
  branding.accent_color === null;

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export interface TenantBrandingApi {
  loadBranding: () => Promise<TenantBrandingEnvelope>;
  /** Accepted M2-B06 owner-only update through the canonical transport. */
  updateBranding?: (update: TenantBrandingPatch) => Promise<TenantBrandingEnvelope>;
  readPrincipal?: () => string | null;
  subscribeSession?: (listener: () => void) => () => void;
}

export interface TenantBrandingController {
  getState(): TenantBrandingState;
  subscribe(listener: (state: TenantBrandingState) => void): () => void;
  /** Explicit panel open: exactly ONE owner read, never before. */
  open(): Promise<void>;
  /** Closes the panel: the confirmed branding, drafts and preview are cleared. */
  close(): void;
  /** A deliberate read of the CURRENT state (never a write). */
  refresh(): Promise<void>;
  /** Opens the editor seeded from the confirmed values (no request). */
  openEditor(): void;
  /** Closes the editor and discards the drafts (no request). */
  cancelEditor(): void;
  /** Updates one text draft without issuing a request. */
  updateDraft(field: TenantBrandingField, value: string): void;
  /** Toggles the explicit "inherit" control for one field (no request). */
  setInherit(field: TenantBrandingField, inherit: boolean): void;
  /** Explicit single-flight save of the DIRTY SUBSET only. */
  save(): Promise<void>;
  /** Deliberate read-only reconciliation after an uncertain save. */
  reconcile(): Promise<void>;
  /** Switches the LOCAL preview only — never a global locale. */
  setPreviewLocale(locale: TenantBrandingLocale): void;
  waitForIdle(): Promise<void>;
  dispose(): void;
}

type ReadMode = 'open' | 'refresh' | 'reconcile';

export function createTenantBrandingController(api: TenantBrandingApi): TenantBrandingController {
  let state = initialState;
  let disposed = false;
  const listeners = new Set<(state: TenantBrandingState) => void>();
  const pending = new Set<Promise<unknown>>();
  const tickets = createTicketSource();
  /** One read at a time. */
  const readGuard = createCourseOperationGuard(tickets);
  /** One write at a time: a double-clicked save never sends a second write. */
  const writeGuard = createCourseOperationGuard(tickets);
  /** Read generation: every read advances it. */
  let readGeneration = 0;
  /** Request generation: every save advances it. */
  let requestGeneration = 0;
  /** Form generation: opening, cancelling or invalidating advances it. */
  let formGeneration = 0;
  /** Incremented by every CONFIRMED save: a read that started before it must
   *  not commit its now-stale value. */
  let confirmedWriteEpoch = 0;
  /** The write ticket of the operation that OWNS the visible mutation state.
   *  A retired operation may settle the visible mutation only while it still
   *  owns it, so an older reply can never clear a newer save's `saving`
   *  status, its error, its notice or its form (supervisor/202). */
  let mutationOwner = 0;
  /** The read that owns the visible loading phase. */
  let phaseOwner = 0;

  const patch = (changes: Partial<TenantBrandingState>): void => {
    state = { ...state, ...changes };
    for (const listener of [...listeners]) listener(state);
  };

  const patchForm = (changes: Partial<TenantBrandingFormState>): void => {
    patch({ form: { ...state.form, ...changes } });
  };

  const patchMutation = (changes: Partial<TenantBrandingMutationState>): void => {
    patch({ mutation: { ...state.mutation, ...changes } });
  };

  const readPrincipal = (): string | null => (api.readPrincipal ? api.readPrincipal() : null);
  let observedPrincipal = readPrincipal();

  /** Clears every private trace of the panel (branding, drafts, preview). */
  const clearPrivateState = (): Partial<TenantBrandingState> => ({
    phase: 'idle',
    branding: null,
    error: null,
    reason: null,
    lastConfirmed: null,
    form: closedForm(),
    mutation: idleMutation(),
  });

  /**
   * Discards everything in flight and the latches they hold. The generations
   * are advanced so a reply that is still on the wire can no longer commit.
   */
  const retireInFlight = (): void => {
    readGeneration += 1;
    requestGeneration += 1;
    formGeneration += 1;
    // The visible mutation is cleared with the rest of the private state, so
    // no operation owns it any more.
    mutationOwner = 0;
    readGuard.release();
    writeGuard.release();
  };

  /** Adopts an observed principal change (a silent logout or scope swap). */
  const adoptPrincipalChange = (observed: string | null): boolean => {
    if (observed === observedPrincipal) return false;
    observedPrincipal = observed;
    retireInFlight();
    patch(clearPrivateState());
    return true;
  };

  /**
   * Adopts an observed principal change on behalf of a RETIRED operation: it
   * must observe the canonical principal BEFORE it settles any visible state.
   * The latches are deliberately NOT released here — every operation releases
   * its own ticket in its `finally`.
   */
  const adoptRetiredPrincipalChange = (observed: string | null): boolean => {
    if (observed === observedPrincipal) return false;
    observedPrincipal = observed;
    readGeneration += 1;
    requestGeneration += 1;
    formGeneration += 1;
    // The private state (and with it the visible mutation) is cleared below.
    mutationOwner = 0;
    patch(clearPrivateState());
    return true;
  };

  const track = (operation: Promise<unknown>): void => {
    pending.add(operation);
    void operation.then(
      () => { pending.delete(operation); },
      () => { pending.delete(operation); },
    );
  };

  /** Settles the loading phase a retired read owns. */
  const settleReadPhase = (phaseToken: number): void => {
    if (phaseOwner !== phaseToken) return;
    if (state.phase !== 'loading') return;
    patch({ phase: state.branding ? 'ready' : 'idle', error: null, reason: null });
  };

  const reconcileNoticeIfCurrent = (): void => {
    if (state.mutation.status !== 'uncertain') return;
    patchMutation({ notice: BRANDING_RECONCILED_MESSAGE });
  };

  /** Seeds the form from the confirmed branding (or all-inherit when absent). */
  const seedForm = (branding: TenantBranding | null): TenantBrandingFormState => ({
    mode: 'editing',
    display_name_ar: { inherit: branding?.display_name_ar === null || branding === null, text: branding?.display_name_ar ?? '' },
    display_name_en: { inherit: branding?.display_name_en === null || branding === null, text: branding?.display_name_en ?? '' },
    accent_color: { inherit: branding?.accent_color === null || branding === null, text: branding?.accent_color ?? '' },
    originalAr: branding?.display_name_ar ?? null,
    originalEn: branding?.display_name_en ?? null,
    originalAccent: branding?.accent_color ?? null,
    error: null,
    notice: null,
  });

  const runRead = async (mode: ReadMode): Promise<void> => {
    if (disposed) return;
    if (!state.open) return;
    const entryPrincipal = readPrincipal();
    if (adoptPrincipalChange(entryPrincipal)) return;
    // A read is already on the wire: a double-clicked refresh never reaches the
    // transport.
    if (!readGuard.acquire()) return;
    const ticket = readGuard.holder();
    const generation = ++readGeneration;
    const epoch = confirmedWriteEpoch;
    const principal = entryPrincipal;
    const phaseToken = ++phaseOwner;
    patch({ phase: 'loading', error: null, reason: null });
    try {
      const body = await api.loadBranding();
      if (disposed) return;
      if (generation !== readGeneration) {
        const observed = readPrincipal();
        if (observed !== principal && adoptRetiredPrincipalChange(observed)) return;
        settleReadPhase(phaseToken);
        return;
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return;
      }
      if (epoch !== confirmedWriteEpoch) {
        // A confirmed save landed while this read was on the wire, so the value
        // it carries is already stale: it is never committed over it.
        settleReadPhase(phaseToken);
        return;
      }
      const parsed = parseTenantBrandingEnvelope(body);
      if (!parsed.ok) {
        patch({
          phase: 'error',
          branding: null,
          error: MALFORMED_BRANDING_MESSAGE,
          reason: 'unknown',
        });
        return;
      }
      patch({
        phase: isAbsentBranding(parsed.branding) ? 'empty' : 'ready',
        branding: parsed.branding,
        error: null,
        reason: null,
      });
      if (mode === 'reconcile') reconcileNoticeIfCurrent();
    } catch (cause) {
      if (disposed) return;
      if (generation !== readGeneration) {
        const observed = readPrincipal();
        if (observed !== principal && adoptRetiredPrincipalChange(observed)) return;
        settleReadPhase(phaseToken);
        return;
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return;
      }
      if (epoch !== confirmedWriteEpoch) {
        settleReadPhase(phaseToken);
        return;
      }
      const failure = classifyTenantBrandingFailure(cause);
      if (isTenantBrandingAuthorizationLoss(failure.reason)) {
        // A DEFINITE loss of the read authorization or of the tenant scope: the
        // confirmed branding, the drafts, the notice and the preview are cleared
        // and every in-flight operation is retired.
        retireInFlight();
        patch({
          ...clearPrivateState(),
          phase: failure.phase,
          error: failure.message,
          reason: failure.reason,
        });
        return;
      }
      // A retryable read failure: the permission loss is NOT proven, so the
      // private draft survives for a deliberate retry.
      patch({
        phase: failure.phase,
        branding: null,
        error: failure.message,
        reason: failure.reason,
      });
    } finally {
      readGuard.release(ticket);
    }
  };

  /**
   * Settles a save that can no longer commit because a newer operation or a
   * session change owns the displayed state. The reply is never committed and
   * never claims success; a genuinely unknown outcome stays explicitly
   * uncertain.
   *
   * It settles ONLY the operation's OWN still-visible lifecycle: when a newer
   * operation already owns the visible mutation, this retired reply must not
   * touch that operation's status, error, notice or form (supervisor/202).
   */
  const settleSupersededMutation = (owner: number, body: unknown | null, cause: unknown | null): void => {
    // A newer operation owns the visible mutation: an older reply may never
    // settle it.
    if (mutationOwner !== owner) return;
    if (state.mutation.status !== 'saving') return;
    if (cause !== null) {
      const failure = classifyTenantBrandingWriteFailure(cause);
      if (failure.kind === 'unauthorized') {
        retireInFlight();
        patch(clearPrivateState());
        return;
      }
      if (failure.kind === 'uncertain') {
        patchMutation({
          status: 'uncertain',
          error: failure.message,
          notice: BRANDING_WRITE_UNCERTAIN_MESSAGE,
        });
        return;
      }
      patchMutation({ status: 'idle', error: failure.message, notice: null });
      return;
    }
    const parsed = parseTenantBrandingEnvelope(body);
    if (!parsed.ok) {
      patchMutation({ status: 'uncertain', error: null, notice: BRANDING_WRITE_UNCERTAIN_MESSAGE });
      return;
    }
    patchMutation({ status: 'idle', error: null, notice: null });
  };

  const runSave = async (patchBody: TenantBrandingPatch): Promise<void> => {
    if (disposed) return;
    if (!api.updateBranding) return;

    const entryPrincipal = readPrincipal();
    if (adoptPrincipalChange(entryPrincipal)) return;
    if (disposed) return;

    // Synchronous single-flight: a second click/Enter before the first await
    // never reaches the transport.
    if (!writeGuard.acquire()) return;
    const ticket = writeGuard.holder();
    const token = ++requestGeneration;
    const formToken = formGeneration;
    const principal = entryPrincipal;
    // This operation OWNS the visible mutation until it settles it, a newer
    // operation takes it over, or the private state is cleared.
    mutationOwner = ticket;
    patchMutation({ status: 'saving', error: null, notice: null });
    try {
      const response = await api.updateBranding(patchBody);
      if (disposed) return;
      if (token !== requestGeneration) {
        const committedPrincipal = readPrincipal();
        if (committedPrincipal !== principal) {
          adoptPrincipalChange(committedPrincipal);
          return;
        }
        settleSupersededMutation(ticket, response, null);
        return;
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return;
      }
      const parsed = parseTenantBrandingEnvelope(response);
      if (!parsed.ok) {
        // A 2xx success with a body that cannot be validated is not success.
        patchMutation({ status: 'uncertain', error: null, notice: BRANDING_WRITE_UNCERTAIN_MESSAGE });
        return;
      }
      // Server-authoritative success only.
      confirmedWriteEpoch += 1;
      const confirmed = parsed.branding;
      patch({
        branding: confirmed,
        lastConfirmed: confirmed,
        phase: isAbsentBranding(confirmed) ? 'empty' : 'ready',
        error: null,
        reason: null,
      });
      if (formGeneration === formToken) {
        // The form this save belonged to is still the current one, so it closes.
        formGeneration += 1;
        patchForm(closedForm());
      }
      patchMutation({ status: 'idle', error: null, notice: null });
    } catch (cause) {
      if (disposed) return;
      if (token !== requestGeneration) {
        const committedPrincipal = readPrincipal();
        if (committedPrincipal !== principal) {
          adoptPrincipalChange(committedPrincipal);
          return;
        }
        settleSupersededMutation(ticket, null, cause);
        return;
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return;
      }
      const failure = classifyTenantBrandingWriteFailure(cause);
      if (failure.kind === 'unauthorized') {
        retireInFlight();
        patch(clearPrivateState());
        return;
      }
      if (failure.kind === 'uncertain') {
        // The save may or may not have persisted: it stays explicitly uncertain,
        // the draft is preserved and NO write is retried automatically.
        patchMutation({
          status: 'uncertain',
          error: failure.message,
          notice: BRANDING_WRITE_UNCERTAIN_MESSAGE,
        });
        return;
      }
      // Denied/invalid: the server did not write. The draft is preserved and the
      // user may retry explicitly.
      patchMutation({ status: 'idle', error: failure.message, notice: null });
    } finally {
      // Only its own ticket: a retired save's `finally` can never release a
      // newer save's latch.
      writeGuard.release(ticket);
    }
  };

  const unsubscribeSession = api.subscribeSession
    ? api.subscribeSession(() => {
        if (disposed) return;
        // Another principal (or a logout): every in-flight reply is foreign and
        // the private state is cleared BEFORE any new read starts.
        retireInFlight();
        observedPrincipal = readPrincipal();
        patch(clearPrivateState());
        if (state.open) {
          const operation = runRead('open');
          track(operation);
        }
      })
    : undefined;

  const dispose = (): void => {
    disposed = true;
    if (unsubscribeSession) unsubscribeSession();
    retireInFlight();
    patch({ open: false, ...clearPrivateState() });
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(state);
      return () => { listeners.delete(listener); };
    },
    open: () => {
      if (disposed) return Promise.resolve();
      if (state.open) return Promise.resolve();
      patch({ open: true });
      const operation = runRead('open');
      track(operation);
      return operation;
    },
    close: () => {
      if (disposed) return;
      retireInFlight();
      patch({ open: false, ...clearPrivateState() });
    },
    refresh: () => {
      if (disposed) return Promise.resolve();
      const operation = runRead('refresh');
      track(operation);
      return operation;
    },
    openEditor: () => {
      if (disposed) return;
      if (state.form.mode !== 'closed') return;
      if (state.phase !== 'ready' && state.phase !== 'empty') return;
      formGeneration += 1;
      patch({ form: seedForm(state.branding) });
    },
    cancelEditor: () => {
      if (disposed) return;
      if (state.form.mode === 'closed') return;
      formGeneration += 1;
      patchForm(closedForm());
    },
    updateDraft: (field, value) => {
      if (disposed) return;
      if (state.form.mode === 'closed') return;
      patchForm({
        [field]: { inherit: false, text: value },
        error: null,
        notice: null,
      } as Partial<TenantBrandingFormState>);
    },
    setInherit: (field, inherit) => {
      if (disposed) return;
      if (state.form.mode === 'closed') return;
      const current = state.form[field];
      if (current.inherit === inherit) return;
      patchForm({
        [field]: { inherit, text: current.text },
        error: null,
        notice: null,
      } as Partial<TenantBrandingFormState>);
    },
    save: () => {
      if (disposed) return Promise.resolve();
      if (state.form.mode !== 'editing') return Promise.resolve();
      const built = buildTenantBrandingPatch(state.form);
      if ('message' in built) {
        // Local validation happens BEFORE any request and keeps the input.
        patchForm({ error: built.message, notice: null });
        return Promise.resolve();
      }
      if (built.dirtyCount === 0) {
        // No effective change: NO request is sent at all.
        patchForm({ error: null, notice: BRANDING_NO_CHANGES_MESSAGE });
        return Promise.resolve();
      }
      const operation = runSave(built.patch);
      track(operation);
      return operation;
    },
    reconcile: () => {
      if (disposed) return Promise.resolve();
      // Deliberate, explicit GET only after an uncertain save. It never retries
      // the save and never claims it succeeded.
      if (state.mutation.status !== 'uncertain') return Promise.resolve();
      const operation = runRead('reconcile');
      track(operation);
      return operation;
    },
    setPreviewLocale: (locale) => {
      if (disposed) return;
      if (state.previewLocale === locale) return;
      // The LOCAL preview only: no global locale, theme or provider changes.
      patch({ previewLocale: locale });
    },
    waitForIdle: async () => {
      while (pending.size > 0) {
        await Promise.all([...pending]);
      }
    },
    dispose,
  };
}
