import assert from "node:assert/strict";
import test from "node:test";
import { can, canAccessRoute, defaultRouteFor } from "./access-control";

test("student can consume learning but cannot manage courses", () => {
  const student = { role: "student" };
  assert.equal(can(student, "learning.consume"), true);
  assert.equal(canAccessRoute(student, "/student-exams"), true);
  assert.equal(canAccessRoute(student, "/courses"), false);
  assert.equal(canAccessRoute(student, "/support"), true);
});

test("legacy staff pages are translated into capabilities", () => {
  const staff = { role: "staff", accessible_pages: ["students", "messages"] };
  assert.equal(canAccessRoute(staff, "/teacher"), true);
  assert.equal(canAccessRoute(staff, "/students"), true);
  assert.equal(canAccessRoute(staff, "/messages"), true);
  assert.equal(canAccessRoute(staff, "/expenses"), false);
});

test("explicit permissions override the compatibility role map", () => {
  const user = { role: "teacher", effective_permissions: ["message.use"] };
  assert.equal(canAccessRoute(user, "/messages"), true);
  assert.equal(canAccessRoute(user, "/students"), false);
});

test("an explicitly empty permission set does not inherit legacy role privileges", () => {
  const user = { role: "teacher", effective_permissions: [] };
  assert.equal(canAccessRoute(user, "/teacher"), false);
  assert.equal(canAccessRoute(user, "/students"), false);
});

test("dynamic exam routes use the exam capability", () => {
  assert.equal(canAccessRoute({ role: "instructor" }, "/teacher/exams/12/edit"), true);
  assert.equal(canAccessRoute({ role: "student" }, "/teacher/exams/12/edit"), false);
});

test("default route follows the effective workspace", () => {
  assert.equal(defaultRouteFor({ role: "admin" }), "/admin");
  assert.equal(defaultRouteFor({ role: "student" }), "/student");
  assert.equal(defaultRouteFor({ role: "instructor" }), "/teacher");
  assert.equal(defaultRouteFor({ role: "staff", accessible_pages: [] }), "/");
});

test("platform admin sees business operations, not instructor teaching pages", () => {
  const admin = { role: "admin" };
  assert.equal(canAccessRoute(admin, "/admin"), true);
  assert.equal(canAccessRoute(admin, "/admin/instructors"), true);
  assert.equal(canAccessRoute(admin, "/admin/instructors/example-id"), true);
  assert.equal(canAccessRoute(admin, "/admin/operations"), true);
  assert.equal(canAccessRoute(admin, "/admin/team"), true);
  assert.equal(canAccessRoute(admin, "/support"), true);
  assert.equal(canAccessRoute(admin, "/teacher"), false);
  assert.equal(canAccessRoute(admin, "/students"), false);
  assert.equal(canAccessRoute(admin, "/instructor-lectures"), false);
});

test("explicitly appointed staff admin uses platform permissions instead of legacy teaching pages", () => {
  const supportAdmin = {
    role: "staff",
    accessible_pages: ["students"],
    admin_member: true,
    admin_permissions: ["admin.dashboard.read", "support.read", "task.read"],
  };
  assert.equal(defaultRouteFor(supportAdmin), "/admin");
  assert.equal(canAccessRoute(supportAdmin, "/admin"), true);
  assert.equal(canAccessRoute(supportAdmin, "/support"), true);
  assert.equal(canAccessRoute(supportAdmin, "/admin/operations"), true);
  assert.equal(canAccessRoute(supportAdmin, "/admin/instructors"), false);
  assert.equal(canAccessRoute(supportAdmin, "/admin/team"), false);
  assert.equal(canAccessRoute(supportAdmin, "/students"), false);
});

test("admin workspaces expose routes by job role", () => {
  const operations = { role: "staff", admin_member: true, admin_permissions: ["admin.dashboard.read", "instructor.read", "subscription.read", "task.read"] };
  assert.equal(canAccessRoute(operations, "/admin/instructors"), true);
  assert.equal(canAccessRoute(operations, "/admin/platform"), true);
  assert.equal(canAccessRoute(operations, "/admin/operations"), true);
  assert.equal(canAccessRoute(operations, "/admin/approvals"), false);
  assert.equal(canAccessRoute(operations, "/admin/team"), false);

  const security = { role: "staff", admin_member: true, admin_permissions: ["admin.dashboard.read", "security.read", "audit.read", "task.read"] };
  assert.equal(canAccessRoute(security, "/admin"), true);
  assert.equal(canAccessRoute(security, "/admin/operations"), true);
  assert.equal(canAccessRoute(security, "/admin/security"), true);
  assert.equal(canAccessRoute(security, "/admin/finance"), false);
  assert.equal(canAccessRoute(security, "/admin/instructors"), false);
  assert.equal(canAccessRoute(security, "/admin/platform"), false);

  const analyst = { role: "staff", admin_member: true, admin_permissions: ["admin.dashboard.read", "finance.read"] };
  assert.equal(canAccessRoute(analyst, "/admin"), true);
  assert.equal(canAccessRoute(analyst, "/admin/finance"), true);
  assert.equal(canAccessRoute(analyst, "/admin/analytics/overview"), true);
  assert.equal(canAccessRoute(analyst, "/admin/analytics/charts"), true);
  assert.equal(canAccessRoute(analyst, "/admin/analytics/scenarios"), true);
  assert.equal(canAccessRoute(analyst, "/admin/analytics/reports"), true);
  assert.equal(canAccessRoute(analyst, "/admin/analytics/governance"), true);
  assert.equal(canAccessRoute(analyst, "/admin/security"), false);
  assert.equal(canAccessRoute(analyst, "/admin/platform"), false);
  assert.equal(canAccessRoute(analyst, "/admin/operations"), false);
});
