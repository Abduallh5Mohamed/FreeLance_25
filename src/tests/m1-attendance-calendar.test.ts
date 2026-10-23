/**
 * M1 attendance business-day calendar — Africa/Cairo (frontend helper +
 * server parity, hermetic).
 *
 * Runner: node:test via tsx (`npx tsx --test src/tests/m1-attendance-calendar.test.ts`).
 * No DOM/jsdom, no env files, no database, no network, no live services, no
 * application startup.
 *
 * Scope of production code exercised:
 *  - the shared attendance business-day helper `src/lib/attendance-calendar.ts`
 *    (day-key validation, instant->Cairo-day conversion, default day, schedule
 *    arithmetic), used by the attendance pages;
 *  - PARITY: the backend mirror `server/src/lib/attendance-calendar.ts` is
 *    imported (it has no imports or side effects) and asserted to produce
 *    identical outputs, so a page and the server can never disagree about
 *    which calendar day an instant denotes.
 *
 * The contract (supervisor/026): Africa/Cairo is the authoritative attendance
 * business timezone for defaults, instant-to-day conversion and
 * scheduled-weekday/previous-day decisions. Explicit YYYY-MM-DD keys are
 * calendar days: preserved unchanged, impossible days rejected. Timezone
 * behavior comes from runtime Intl — no hardcoded offsets, no host-local math.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ATTENDANCE_TIMEZONE,
  instantToDayKey,
  isScheduledOnDayKey,
  isValidDayKey,
  normalizeAttendanceDay,
  parseScheduleWeekdays,
  previousScheduledDayKey,
  todayDayKey,
  weekdayOfDayKey,
} from "../lib/attendance-calendar";

// The backend mirror lives in the server package (CommonJS under tsx), so the
// namespace import is unwrapped through the CJS/ESM interop default.
const serverModule = await import("../../server/src/lib/attendance-calendar");
const serverCalendar: typeof import("../../server/src/lib/attendance-calendar") =
  (serverModule as { default?: typeof serverModule }).default ?? serverModule;

// ---------------------------------------------------------------------------
// Frontend helper unit tests
// ---------------------------------------------------------------------------

test("Africa/Cairo is the authoritative attendance business timezone", () => {
  assert.equal(ATTENDANCE_TIMEZONE, "Africa/Cairo");
  assert.equal(serverCalendar.ATTENDANCE_TIMEZONE, "Africa/Cairo");
});

test("day keys validate as real calendar dates (no rollover)", () => {
  assert.equal(isValidDayKey("2026-10-16"), true);
  assert.equal(isValidDayKey("2028-02-29"), true, "leap day is valid in a leap year");
  assert.equal(isValidDayKey("2026-02-29"), false, "non-leap February 29 is rejected");
  assert.equal(isValidDayKey("2026-02-30"), false, "impossible day is rejected, not rolled over");
  assert.equal(isValidDayKey("2026-13-01"), false);
  assert.equal(isValidDayKey("2026-1-1"), false, "shape must be strict YYYY-MM-DD");
  assert.equal(isValidDayKey("not-a-day"), false);
  assert.equal(isValidDayKey(null), false);
});

test("instants convert to the Africa/Cairo calendar day they denote (DST-aware)", () => {
  // Cairo summer (EEST, UTC+3): 21:30Z is already the next Cairo day.
  assert.equal(instantToDayKey("2026-10-16T21:30:00Z"), "2026-10-17");
  // Cairo winter (EET, UTC+2): 21:30Z is still 23:30 the same Cairo day.
  assert.equal(instantToDayKey("2026-11-16T21:30:00Z"), "2026-11-16");
  // Egypt 2026 DST starts 2026-04-24 00:00 Cairo (UTC+2 -> UTC+3).
  assert.equal(instantToDayKey("2026-04-23T21:30:00Z"), "2026-04-23");
  assert.equal(instantToDayKey("2026-04-24T21:30:00Z"), "2026-04-25");
  assert.equal(instantToDayKey(new Date("2026-10-16T21:30:00Z")), "2026-10-17");
  assert.equal(instantToDayKey("garbage"), null);
});

test("029: parseScheduleWeekdays never throws on valid JSON that is not an array", () => {
  for (const value of ["null", "{}", "42", '"sun"']) {
    assert.deepEqual(parseScheduleWeekdays(value), [], `JSON ${value} must be an empty schedule`);
  }
  assert.deepEqual(parseScheduleWeekdays("{}"), serverCalendar.parseScheduleWeekdays("{}"));
  assert.deepEqual(parseScheduleWeekdays("42"), serverCalendar.parseScheduleWeekdays("42"));
});

test("029: impossible instant dates are rejected, never rolled over", () => {
  assert.equal(normalizeAttendanceDay("2026-02-30T00:00:00Z"), null, "impossible day rolled over before the fix");
  assert.equal(normalizeAttendanceDay("2026-02-30T00:00:00Z"), serverCalendar.normalizeAttendanceDay("2026-02-30T00:00:00Z"));
  assert.equal(normalizeAttendanceDay("2026-13-01T00:00:00Z"), null, "impossible month rejected");
  assert.equal(normalizeAttendanceDay("2026-02-29T00:00:00Z"), null, "non-leap February 29 rejected");
  assert.equal(normalizeAttendanceDay("2026-10-16T25:00:00Z"), null, "impossible hour rejected");
  assert.equal(normalizeAttendanceDay("2028-02-29T12:00:00Z"), "2028-02-29", "valid leap-day instant still converts");
});

test("029: instant strings must carry an explicit timezone/offset", () => {
  // Offsetless datetimes parse host-locally — rejected rather than silently
  // producing a host-dependent day.
  assert.equal(instantToDayKey("2026-10-16T21:30:00"), null, "offsetless datetime rejected");
  assert.equal(instantToDayKey("2026-10-16T21:30"), null, "offsetless datetime rejected");
  assert.equal(normalizeAttendanceDay("2026-10-16T21:30:00"), null);
  assert.equal(instantToDayKey("2026-10-16 21:30:00"), null, "MySQL-style offsetless datetime rejected");
  // Explicit offsets are honored: 21:30Z is already the next Cairo summer day,
  // while +02:00 keeps the same day in winter.
  assert.equal(instantToDayKey("2026-10-16T21:30:00.500Z"), "2026-10-17", "fractional seconds accepted");
  assert.equal(instantToDayKey("2026-11-16T21:30:00+02:00"), "2026-11-16", "explicit +02:00 honored in winter");
  assert.equal(instantToDayKey("2026-04-23T22:30:00+02:00"), "2026-04-23", "pre-DST explicit +02:00 keeps 2026-04-23");
  assert.equal(instantToDayKey("2026-04-24T00:30:00+02:00"), "2026-04-24", "wall time just past midnight with the pre-switch offset lands in the post-switch Cairo day");
  assert.equal(
    instantToDayKey("2026-11-16T21:30:00+02:00"),
    serverCalendar.instantToDayKey("2026-11-16T21:30:00+02:00"),
    "offset parity",
  );
});

test("029: day keys remain usable instants and impossible keys are rejected", () => {
  assert.equal(instantToDayKey("2026-10-16"), "2026-10-16", "day key is a deterministic UTC-midnight instant");
  assert.equal(instantToDayKey("2026-02-30"), null, "impossible day key rejected");
  assert.equal(instantToDayKey("2026-10-16"), serverCalendar.instantToDayKey("2026-10-16"), "day-key parity");
});

test("the default day is the current Africa/Cairo day, from an explicit instant", () => {
  assert.equal(todayDayKey(new Date("2026-10-16T21:30:00Z")), "2026-10-17");
  assert.equal(todayDayKey(new Date("2026-11-16T21:30:00Z")), "2026-11-16");
  // The real-clock default is always a usable calendar-day key.
  assert.ok(isValidDayKey(todayDayKey()));
});

test("normalizeAttendanceDay preserves explicit keys and converts instants", () => {
  assert.equal(normalizeAttendanceDay("2026-10-16"), "2026-10-16", "explicit key preserved unchanged");
  assert.equal(normalizeAttendanceDay("2026-02-30"), null, "impossible key rejected");
  assert.equal(normalizeAttendanceDay("2026-10-16T21:30:00Z"), "2026-10-17");
  assert.equal(normalizeAttendanceDay(new Date("2026-10-16T21:30:00Z")), "2026-10-17");
  assert.equal(normalizeAttendanceDay(undefined), null);
  assert.equal(normalizeAttendanceDay(null), null);
  assert.equal(normalizeAttendanceDay(""), null);
});

test("schedule arithmetic is pure calendar weekday math", () => {
  assert.deepEqual(parseScheduleWeekdays('["mon","WED","bogus"]'), [1, 3]);
  assert.deepEqual(parseScheduleWeekdays("not-json"), []);
  assert.deepEqual(parseScheduleWeekdays(null), []);
  assert.equal(weekdayOfDayKey("2026-10-16"), 5, "2026-10-16 is a Friday");
  assert.equal(isScheduledOnDayKey("2026-10-16", [5]), true);
  assert.equal(isScheduledOnDayKey("2026-10-16", [1, 3]), false);
  // Mon/Wed before Friday 2026-10-16 is Wednesday 2026-10-14.
  assert.equal(previousScheduledDayKey("2026-10-16", [1, 3]), "2026-10-14");
  // Friday-only schedule: the previous session is one week earlier.
  assert.equal(previousScheduledDayKey("2026-10-16", [5]), "2026-10-09");
  assert.equal(previousScheduledDayKey("2026-10-16", []), null);
  assert.equal(previousScheduledDayKey("2026-02-30", [1]), null, "invalid reference rejected");
});

// ---------------------------------------------------------------------------
// Server parity: the backend mirror must produce identical outputs, so a page
// and the server can never disagree about which calendar day "today" or an
// instant denotes.
// ---------------------------------------------------------------------------

test("frontend and server attendance calendars produce identical outputs (parity)", () => {
  const instants = [
    "2026-10-16T21:30:00Z",
    "2026-11-16T21:30:00Z",
    "2026-04-23T21:30:00Z",
    "2026-04-24T21:30:00Z",
    "2026-10-16T00:00:00Z",
    "2026-12-31T22:00:00Z",
    "2028-02-29T12:00:00Z",
    "garbage",
  ];
  for (const value of instants) {
    assert.equal(
      instantToDayKey(value),
      serverCalendar.instantToDayKey(value),
      `instant parity for ${value}`,
    );
    assert.equal(
      normalizeAttendanceDay(value),
      serverCalendar.normalizeAttendanceDay(value),
      `normalize parity for ${value}`,
    );
  }

  const dayKeys = ["2026-10-16", "2026-02-30", "2028-02-29", "2026-13-01", "not-a-day", ""];
  for (const key of dayKeys) {
    assert.equal(isValidDayKey(key), serverCalendar.isValidDayKey(key), `key validity parity for ${key}`);
    assert.equal(
      normalizeAttendanceDay(key),
      serverCalendar.normalizeAttendanceDay(key),
      `explicit key parity for ${key}`,
    );
  }

  const schedules = ['["mon","wed"]', '["fri"]', "[]", "not-json", null, undefined];
  for (const schedule of schedules) {
    assert.deepEqual(
      parseScheduleWeekdays(schedule),
      serverCalendar.parseScheduleWeekdays(schedule),
      `schedule parity for ${String(schedule)}`,
    );
  }

  for (const reference of ["2026-10-16", "2026-02-30", "2026-01-01"]) {
    for (const weekdays of [[1, 3], [5], []]) {
      assert.equal(
        previousScheduledDayKey(reference, weekdays),
        serverCalendar.previousScheduledDayKey(reference, weekdays),
        `previous-scheduled parity for ${reference} / ${weekdays.join(",")}`,
      );
    }
  }

  assert.equal(
    todayDayKey(new Date("2026-10-16T21:30:00Z")),
    serverCalendar.todayDayKey(new Date("2026-10-16T21:30:00Z")),
  );
});
