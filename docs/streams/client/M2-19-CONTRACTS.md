# M2-19 — client contracts for private bounded group weekly schedules

Task: `client-m2-19-private-group-weekly-schedules-20261023-01`.
Handoff: `docs/streams/client/M2-19-HANDOFF.md`.
Server contract: `docs/streams/server/M2-B11-CONTRACT.md`.
Builds on: the accepted M2-18 lane (controller + transport + fence patterns) and
the existing `/api/groups` screen.

The Groups screen keeps its layout, its Arabic copy, its create/edit dialog with
the seven weekday checkboxes and the time input, its students dialog, its delete
confirmation and its status toggle. This batch replaces the page's ad-hoc
request handling with a production controller and makes the weekly schedule
canonical, bounded and explicitly clearable.

**Timetable metadata only.** Nothing here creates a session, an occurrence, an
attendance record, a notification, an enrollment, an access rule or a billing
effect, and nothing here defines a timezone, a recurrence or an automatic date.

## Modules

| Path | Change |
|---|---|
| `src/lib/api.ts` | **additive** — `GROUP_SCHEDULE_DAYS`, `GROUP_SCHEDULE_DAY_LABELS`, `GroupSchedule`, `GroupScheduleWrite`, `canonicalGroupDays`, `canonicalGroupTime`, `parseGroupSchedule`, `parseGroupScheduleList`, `listGroupSchedules`, `createGroupSchedule`, `updateGroupSchedule`, `deleteGroupSchedule`. The existing `export * from './api-http'` is preserved unchanged. |
| `src/features/groups/group-schedules.ts` | **new** — the pure canonical helpers, the failure classifiers and `createGroupScheduleController` |
| `src/pages/Groups.tsx` | **rewired** — mounts `createProductionGroupScheduleController()`, renders `GroupSchedule` rows, shows the weekly schedule per group, surfaces the real failure message with a retry |
| `src/tests/m2-group-schedules.test.ts` | **new** — 44 hermetic tests over the real adapters and the real controller |

`api-http.ts` is **not** edited: `request` is module-private and its
`updateGroup`/`deleteGroup` swallow every error into a boolean, which is exactly
the "misleading mutation failure" this batch removes. The new adapters therefore
own a small transport that reproduces the canonical helper's documented
observable behaviour (bearer token, JSON content type, `error.error` as the
thrown message, the `BILLING_ONLY` identity event + redirect and the
`TENANT_SUSPENDED` teardown) and add nothing else.

## The DTO — strict, bounded, canonical

`parseGroupSchedule(body)` accepts **only** a non-null object whose key set is
exactly the ten projected fields, whose `id`/`name` are non-empty strings, whose
`description`/`course_id`/`grade_id` are `string | null`, whose
`max_students`/`current_students` are finite numbers, whose `is_active` is a
boolean, whose `schedule_days` is an array of **unique known** weekday keys of at
most seven entries, and whose `schedule_time` is `HH:mm` or `null`.

An extra key (`tenant_id`, `instructor_id`, a spread row), a missing key, a
duplicate weekday, an unknown weekday, an eighth entry or a `HH:mm:ss` echo is a
**malformed response** — never a fabricated group. A malformed row fails the
whole list read: the controller holds **no** partial list.

`canonicalGroupDays` re-emits the surviving keys in canonical order, so a body
that arrives in another order is normalised rather than trusted. `null` and `[]`
both mean "no days" and are both valid.

## The write body — explicit, never accidental

The controller **always** sends `schedule_days` and `schedule_time`, even when
they are empty:

```json
{
  "name": "Physics A",
  "description": "Intro" ,
  "grade_id": null,
  "max_students": 20,
  "is_active": true,
  "schedule_days": ["sat", "mon"],
  "schedule_time": "17:05"
}
```

- unchecking the last weekday sends `schedule_days: []` — an explicit clear, not
  an omission;
- clearing the time input sends `schedule_time: null` — an explicit clear;
- an empty description or grade selector is sent as `null` (an explicit clear),
  never dropped;
- `course_id` is **omitted** because the existing screen has no course selector;
  omission keeps the stored value, which is the correct behaviour;
- `is_active` is preserved from the loaded row on edit and is `true` on create.

A body key the server does not allow is never produced: the write object is built
field by field, never by spreading the form.

## Local validation — before the transport

| Rule | Message |
|---|---|
| name trimmed to 1..255 | `GROUP_NAME_INVALID_MESSAGE` |
| `max_students` an integer 1..1000 | `GROUP_MAX_STUDENTS_INVALID_MESSAGE` |
| time empty or `HH:mm` | `GROUP_TIME_INVALID_MESSAGE` |

A locally invalid save returns `'invalid'`, sets `form.error`, keeps the form
open with the user's input and issues **zero** requests.

## Failure classification — documented messages only

The transport throws the server's `error` message without the HTTP status and
without the `code`, so only documented wording classifies an outcome.

Read: `unauthorized` (session answers), `denied` (suspension, teaching denial,
`Forbidden`), `no-workspace` (`Tenant membership not found`), `server`
(`Failed to fetch groups` / `Failed to fetch group`), otherwise `unknown` with
the real message on screen. No permission is ever inferred from an unrecognized
message.

Write: `unauthorized`, `denied`, `missing` (`Group not found`), `invalid` (the
strict payload rejections), `uncertain` (`Failed to save group` / network /
unrecognized). `uncertain` means the write **may** have persisted.

## Controller surface

```ts
load(): Promise<void>
refresh(): Promise<void>
openCreate(): void
openEdit(groupId: string): void
setField(patch): void
toggleDay(day: GroupScheduleDay): void
cancel(): void
save(): Promise<GroupScheduleWriteOutcome>
remove(groupId: string): Promise<GroupScheduleWriteOutcome>
setActive(groupId: string, active: boolean): Promise<GroupScheduleWriteOutcome>
waitForIdle(): Promise<void>
dispose(): void
```

`GroupScheduleWriteOutcome` is
`'confirmed' | 'rejected' | 'uncertain' | 'blocked' | 'invalid' | 'idle'`, so the
page never has to guess from state whether a toast is a success.

## Lifetimes fenced

| Fence | Behaviour |
|---|---|
| read | one list read at a time; a double-clicked refresh never sends a second request; a superseded reply never commits |
| write | ONE shared latch across save/delete/toggle, taken **before** the first `await`: a double-clicked save, a click plus Enter, or a save racing a delete never sends a second write |
| form | opening, cancelling or invalidating a form advances the form generation, so a late reply never rewrites or closes a newer form |
| target | an update reply carrying another group's id is **not** a success for this write: the outcome stays `uncertain` and the held row is untouched |
| authorization | a definite session/suspension/denial/workspace loss clears the rows, the form and the draft and retires every in-flight operation; a retryable failure keeps the draft |
| not-found | a `404` removes the vanished row and closes a form bound to it |
| session | the canonical principal is re-read at entry **and** at completion of every read and write, on the success and the failure path; a retired operation observes it **before** it settles any visible state; a session event retires in-flight work, clears the private state and starts one read for the new session |
| dispose | nothing commits after the page is gone, and no request is issued |

## Honesty rules

- a 2xx body that cannot be validated is **not** a success (`uncertain`);
- a write reply for another id is **not** a success for this write;
- a confirmed success uses the validated server DTO only — no refresh is issued
  after a write, so a confirmed write costs exactly one request;
- an `uncertain` outcome is never retried automatically; the draft is preserved
  and the page shows the warning;
- a truthful no-op on the server still arrives as a `200` with the current
  projection and is published as a confirmed, unchanged row.

## Explicitly not in this contract

No DOM/RTL rendering assertion, no real HTTP, no database, no live service, no
migration, no timezone or recurrence policy, no session/attendance/notification
effect, no enrollment/access/payment change, and no claim that a weekly schedule
grants or revokes anything.
