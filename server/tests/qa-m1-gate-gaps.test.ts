/**
 * QA M1 gate-gap probes (hermetic source-scan: no DB, no network, no Docker,
 * no real env keys, no app startup).
 *
 * Context: docs/10-roadmap.md M1 closeout requires "API/files/video/jobs/
 * export/cache reject cross-tenant". Comparing server/src/routes (42 route
 * modules) against server/tests shows files, videos, secure-video delivery,
 * materials, exams, attendance, meetings, notifications/support, payments and
 * tenant-admin are pinned by m1-* boundary suites, while three M1 channels
 * had ZERO hermetic coverage:
 *  - export: server/src/routes/admin-insights.ts (GET /finance/export CSV)
 *  - video requests: server/src/routes/instructor-video-requests.ts
 *    (per-request/per-offer A->B reads and transitions)
 *  - cache: the export handler sets no Cache-Control, unlike the files and
 *    secure-video handlers (private, no-store).
 *
 * Style follows the wiring-regression sections of
 * server/tests/m1-video-route-boundary.test.ts: the shipped route text must
 * keep delegating to the verified guards. These tests import nothing, so the
 * MinIO/DB import-time side effects of the route modules never execute.
 *
 * Evidence class: static wiring (the exact guard call in the shipped text).
 * Live row-level A->B denial remains the Docker integration suite's
 * responsibility (NOT RUN here).
 *
 * Test limits (explicit):
 *  - A passing wiring test proves the guard is WIRed, not that MySQL enforces
 *    it row-by-row; a removed guard fails here before it can ship.
 *  - The cache test is intentionally strict: it FAILS on the current source
 *    because the export handler sets Content-Type/Content-Disposition but no
 *    Cache-Control. The failure is the documented M1 cache-gate gap (shared
 *    caches must never store the cross-tenant aggregate CSV).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = (relative: string): string =>
    readFileSync(join(__dirname, '..', 'src', relative), 'utf8');

const insights = src('routes/admin-insights.ts');
const videoRequests = src('routes/instructor-video-requests.ts');

// ---------------------------------------------------------------------------
// Export gate: GET /finance/export (platform aggregate CSV across tenants)
// ---------------------------------------------------------------------------

test('M1 export gate: /finance/export requires the finance.export capability behind authentication (no role-claim bypass)', () => {
    // Router-wide authentication: anonymous callers never reach a handler.
    assert.match(insights, /router\.use\(authenticateToken\)/);
    // The CSV export (aggregate revenue/subscription/payment rows across ALL
    // tenants, plus per-tenant recent-payment detail) requires the verified
    // platform capability, never a JWT role label.
    assert.match(
        insights,
        /router\.get\('\/finance\/export', requireAdminPermission\('finance\.export'\)/,
    );
    // A bare role-claim gate must never authorize this surface.
    assert.doesNotMatch(insights, /requireRoles/);
    // Every export is audit-traced so a cross-tenant disclosure is attributable.
    assert.match(insights, /finance_report\.exported/);
    // The payload leaves as an attachment, never inline-rendered.
    assert.match(insights, /Content-Disposition/);
    assert.match(insights, /attachment; filename="platform-analytics-/);
});

// ---------------------------------------------------------------------------
// Cache gate: the exported aggregate must never sit in a shared cache
// ---------------------------------------------------------------------------

test('M1 cache gate: /finance/export must answer non-cacheable (private, no-store)', () => {
    // Shared non-cacheable contract: one small helper owns the exact header
    // values so every finance export/response stays consistent (mirrors the
    // 'private, no-store' precedent of files.ts and secure-video.ts).
    const shared = src('utils/cache-headers.ts');
    assert.match(shared, /export const setNoStoreCacheHeaders/);
    assert.match(shared, /private, no-store/);
    assert.match(shared, /Pragma/);
    assert.match(shared, /no-cache/);
    // Slice from the export handler to the end of the module: the required
    // non-cacheable answer must come from THIS handler, either by calling
    // the shared helper (the literals then live in the helper module) or by
    // setting equivalent literal headers inline.
    const handler = insights.slice(insights.indexOf("router.get('/finance/export'"));
    if (/setNoStoreCacheHeaders/.test(handler)) return;
    assert.match(handler, /Cache-Control/);
    assert.match(handler, /private/);
    assert.match(handler, /no-store/);
    assert.match(handler, /Pragma/);
});

// ---------------------------------------------------------------------------
// Video gate: instructor video request/offer reads and transitions
// ---------------------------------------------------------------------------

test('M1 video gate: request/offer reads and accept/reject transitions stay requester-or-owner scoped (stranger A reads nothing of pair B)', () => {
    // ownRequest() resolves a row only for its requester or owner; any other
    // instructor resolves null and the handler answers 404 (fail closed).
    assert.match(
        videoRequests,
        /WHERE r\.id=\? AND \(r\.requester_id=\? OR r\.owner_id=\?\)/,
    );
    // The preview-metadata read binds the same pair scope: a stranger's offer
    // id never resolves, so no cross-pair title/price/preview leaks.
    assert.match(
        videoRequests,
        /WHERE o\.id=\? AND \(r\.requester_id=\? OR r\.owner_id=\?\)/,
    );
    // Accept/reject transition only for the requesting side of the pair.
    assert.match(videoRequests, /offer\.requester_id !== req\.user!\.id/);
});
