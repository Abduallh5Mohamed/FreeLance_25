"use strict";
/**
 * C11 schedules + announcements domain policy.
 *
 * Pure, deterministic and clock-free. This module only validates and
 * normalizes input and decides AUDIENCE visibility; it never reads the request,
 * never touches tenant/branch resolution and never performs I/O. The route
 * layer composes it with the verified principal, the server-owned tenant
 * authority lookup and the branch contract.
 *
 * Audience model (deny by default):
 *  - `tenant`  : visible to every active member/enrollment of the tenant.
 *  - `branch`  : visible only to a viewer whose proven branch equals the row's
 *                branch. A viewer with no proven branch never sees it.
 *  - `group`   : schedules only; visible only to a viewer whose proven group
 *                equals the row's group.
 *
 * Time zones: a schedule/announcement may be authored in a tenant-local wall
 * time plus an IANA timezone; it is stored as an absolute UTC instant. An
 * invalid timezone or wall time is rejected (never silently widened). This
 * reuses the C6 release-policy timezone primitives — no duplicate arithmetic.
 *
 * No `any`, no ts-ignore, no network, no runtime DDL.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_BODY_LENGTH = exports.MAX_TITLE_LENGTH = exports.SCHEDULE_AUDIENCES = exports.ANNOUNCEMENT_AUDIENCES = void 0;
exports.normalizeId = normalizeId;
exports.normalizeAnnouncementAudience = normalizeAnnouncementAudience;
exports.normalizeScheduleAudience = normalizeScheduleAudience;
exports.validateAnnouncementInput = validateAnnouncementInput;
exports.validateScheduleInput = validateScheduleInput;
exports.isAnnouncementVisibleTo = isAnnouncementVisibleTo;
exports.isScheduleVisibleTo = isScheduleVisibleTo;
exports.buildVisibleAnnouncementFilter = buildVisibleAnnouncementFilter;
exports.buildVisibleScheduleFilter = buildVisibleScheduleFilter;
exports.toMysqlUtc = toMysqlUtc;
const content_release_1 = require("./content-release");
exports.ANNOUNCEMENT_AUDIENCES = ['tenant', 'branch'];
exports.SCHEDULE_AUDIENCES = ['tenant', 'branch', 'group'];
exports.MAX_TITLE_LENGTH = 200;
exports.MAX_BODY_LENGTH = 5000;
const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
/** Bounded opaque id (tenant/branch/group). Returns null when malformed. */
function normalizeId(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    return idPattern.test(trimmed) ? trimmed : null;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function normalizeAnnouncementAudience(value) {
    if (typeof value !== 'string')
        return null;
    return exports.ANNOUNCEMENT_AUDIENCES.includes(value)
        ? value
        : null;
}
function normalizeScheduleAudience(value) {
    if (typeof value !== 'string')
        return null;
    return exports.SCHEDULE_AUDIENCES.includes(value)
        ? value
        : null;
}
function resolveTimeZone(value) {
    if (value === undefined || value === null || value === '')
        return 'UTC';
    if (typeof value !== 'string')
        return null;
    return (0, content_release_1.isValidTimeZone)(value) ? value : null;
}
function resolveAuthoredInstant(raw, timeZone, label) {
    if (raw === undefined || raw === null || raw === '')
        return { ok: true, value: null };
    if (typeof raw !== 'string')
        return { ok: false, error: `${label} must be a local date/time string` };
    const instant = (0, content_release_1.localWallTimeToInstant)(raw, timeZone);
    if (!instant)
        return { ok: false, error: `${label} must be a valid calendar date/time` };
    return { ok: true, value: instant.toISOString() };
}
/**
 * Validate an announcement create/edit payload. Rejects a branch target on a
 * tenant announcement (and a missing branch on a branch announcement) so the
 * audience can never be widened or left ambiguous by construction.
 */
function validateAnnouncementInput(body) {
    const record = isRecord(body) ? body : {};
    const title = typeof record['title'] === 'string' ? record['title'].trim() : '';
    const text = typeof record['body'] === 'string' ? record['body'].trim() : '';
    const audience = normalizeAnnouncementAudience(record['audience']);
    if (!title)
        return { ok: false, error: 'title is required' };
    if (title.length > exports.MAX_TITLE_LENGTH)
        return { ok: false, error: `title must be at most ${exports.MAX_TITLE_LENGTH} characters` };
    if (!text)
        return { ok: false, error: 'body is required' };
    if (text.length > exports.MAX_BODY_LENGTH)
        return { ok: false, error: `body must be at most ${exports.MAX_BODY_LENGTH} characters` };
    if (!audience)
        return { ok: false, error: 'audience must be tenant or branch' };
    let branchId = null;
    if (audience === 'branch') {
        branchId = normalizeId(record['branch_id']);
        if (!branchId)
            return { ok: false, error: 'branch_id is required for a branch announcement' };
    }
    else if (record['branch_id'] !== undefined && record['branch_id'] !== null && record['branch_id'] !== '') {
        return { ok: false, error: 'a tenant announcement must not target a branch' };
    }
    const timeZone = resolveTimeZone(record['timezone']);
    if (timeZone === null)
        return { ok: false, error: 'timezone is invalid' };
    const published = resolveAuthoredInstant(record['publish_at'], timeZone, 'publish_at');
    if (!published.ok)
        return published;
    return { ok: true, value: { title, body: text, audience, branchId, publishAt: published.value } };
}
/**
 * Validate a schedule create/edit payload. The schedule window is half-open but
 * must be strictly positive (start < end) and is stored as UTC. A branch target
 * requires a branch, a group target requires a group, and a tenant target must
 * not carry either.
 */
function validateScheduleInput(body) {
    const record = isRecord(body) ? body : {};
    const title = typeof record['title'] === 'string' ? record['title'].trim() : '';
    const audience = normalizeScheduleAudience(record['audience']);
    if (!title)
        return { ok: false, error: 'title is required' };
    if (title.length > exports.MAX_TITLE_LENGTH)
        return { ok: false, error: `title must be at most ${exports.MAX_TITLE_LENGTH} characters` };
    if (!audience)
        return { ok: false, error: 'audience must be tenant, branch or group' };
    let branchId = null;
    let groupId = null;
    if (audience === 'branch') {
        branchId = normalizeId(record['branch_id']);
        if (!branchId)
            return { ok: false, error: 'branch_id is required for a branch schedule' };
        if (record['group_id'] !== undefined && record['group_id'] !== null && record['group_id'] !== '') {
            return { ok: false, error: 'a branch schedule must not target a group' };
        }
    }
    else if (audience === 'group') {
        groupId = normalizeId(record['group_id']);
        if (!groupId)
            return { ok: false, error: 'group_id is required for a group schedule' };
        if (record['branch_id'] !== undefined && record['branch_id'] !== null && record['branch_id'] !== '') {
            return { ok: false, error: 'a group schedule must not target a branch' };
        }
    }
    else if ((record['branch_id'] !== undefined && record['branch_id'] !== null && record['branch_id'] !== '') ||
        (record['group_id'] !== undefined && record['group_id'] !== null && record['group_id'] !== '')) {
        return { ok: false, error: 'a tenant schedule must not target a branch or group' };
    }
    const timeZone = resolveTimeZone(record['timezone']);
    if (timeZone === null)
        return { ok: false, error: 'timezone is invalid' };
    const starts = resolveAuthoredInstant(record['starts_at'], timeZone, 'starts_at');
    if (!starts.ok)
        return starts;
    const ends = resolveAuthoredInstant(record['ends_at'], timeZone, 'ends_at');
    if (!ends.ok)
        return ends;
    if (!starts.value || !ends.value)
        return { ok: false, error: 'starts_at and ends_at are required' };
    if (Date.parse(ends.value) <= Date.parse(starts.value)) {
        return { ok: false, error: 'ends_at must be after starts_at' };
    }
    return {
        ok: true,
        value: {
            title,
            audience,
            branchId,
            groupId,
            timezone: timeZone,
            startsAt: starts.value,
            endsAt: ends.value,
        },
    };
}
function sameTenant(rowTenantId, viewer) {
    return rowTenantId !== null && viewer.tenantId !== null && rowTenantId === viewer.tenantId;
}
/** Deny-by-default announcement visibility for one viewer. */
function isAnnouncementVisibleTo(facts, viewer) {
    if (!sameTenant(facts.tenantId, viewer))
        return false;
    const audience = normalizeAnnouncementAudience(facts.audience);
    if (audience === 'tenant')
        return true;
    if (audience === 'branch') {
        return viewer.branchId !== null && facts.branchId !== null && viewer.branchId === facts.branchId;
    }
    return false;
}
/** Deny-by-default schedule visibility for one viewer. */
function isScheduleVisibleTo(facts, viewer) {
    if (!sameTenant(facts.tenantId, viewer))
        return false;
    const audience = normalizeScheduleAudience(facts.audience);
    if (audience === 'tenant')
        return true;
    if (audience === 'branch') {
        return viewer.branchId !== null && facts.branchId !== null && viewer.branchId === facts.branchId;
    }
    if (audience === 'group') {
        return viewer.groupId !== null && facts.groupId !== null && viewer.groupId === facts.groupId;
    }
    return false;
}
/**
 * Row-level announcement visibility predicate emitted to MySQL, so a student
 * never even loads a row outside their audience. A viewer with no proven
 * branch binds NULL into the `branch_id=?` comparison, which matches nothing.
 */
function buildVisibleAnnouncementFilter(viewer) {
    return {
        sql: `(audience='tenant' OR (audience='branch' AND branch_id=?))`,
        params: [viewer.branchId],
    };
}
/** Row-level schedule visibility predicate (tenant / branch / group). */
function buildVisibleScheduleFilter(viewer) {
    return {
        sql: `(audience='tenant' OR (audience='branch' AND branch_id=?) OR (audience='group' AND group_id=?))`,
        params: [viewer.branchId, viewer.groupId],
    };
}
/** Format an ISO UTC instant as a MySQL UTC DATETIME literal. */
function toMysqlUtc(iso) {
    return iso.slice(0, 19).replace('T', ' ');
}
