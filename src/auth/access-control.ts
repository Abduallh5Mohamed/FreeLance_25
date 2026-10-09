export type LegacyRole = "admin" | "teacher" | "instructor" | "staff" | "student";

export interface AccessProfile {
  name?: string;
  role?: string;
  accessible_pages?: string[];
  effective_permissions?: string[];
  permissions?: string[];
  admin_member?: boolean;
  admin_permissions?: string[];
  billing_only?: boolean;
}

export type Capability =
  | "dashboard.admin.view"
  | "dashboard.teacher.view"
  | "dashboard.instructor.view"
  | "dashboard.student.view"
  | "student.read"
  | "student.manage"
  | "registration.manage"
  | "course.manage"
  | "group.manage"
  | "attendance.manage"
  | "billing.manage"
  | "message.use"
  | "support.use"
  | "report.view"
  | "expense.manage"
  | "staff.manage"
  | "instructor.manage"
  | "instructor.detail.read"
  | "task.read"
  | "subscription.read"
  | "subscription.self.read"
  | "approval.read"
  | "admin.roles.manage"
  | "finance.read"
  | "security.read"
  | "video.manage"
  | "wallet.view"
  | "exam.manage"
  | "learning.consume";

const LEGACY_PAGE_CAPABILITIES: Record<string, Capability[]> = {
  students: ["student.read", "student.manage"],
  courses: ["course.manage", "video.manage", "exam.manage"],
  groups: ["group.manage"],
  attendance: ["attendance.manage"],
  fees: ["billing.manage"],
  messages: ["message.use"],
  reports: ["report.view"],
  expenses: ["expense.manage"],
};

const ROLE_CAPABILITIES: Record<LegacyRole, Capability[]> = {
  admin: [
    "dashboard.admin.view",
    "support.use",
    "instructor.manage",
    "instructor.detail.read",
    "task.read",
    "subscription.read",
    "approval.read",
    "admin.roles.manage",
  ],
  teacher: [
    "dashboard.teacher.view",
    "student.read",
    "student.manage",
    "course.manage",
    "group.manage",
    "attendance.manage",
    "billing.manage",
    "message.use",
    "support.use",
    "report.view",
    "expense.manage",
    "video.manage",
    "exam.manage",
  ],
  instructor: [
    "dashboard.teacher.view",
    "dashboard.instructor.view",
    "student.read",
    "student.manage",
    "course.manage",
    "group.manage",
    "attendance.manage",
    "message.use",
    "support.use",
    "report.view",
    "video.manage",
    "wallet.view",
    "subscription.self.read",
    "exam.manage",
  ],
  staff: ["support.use"],
  student: ["dashboard.student.view", "message.use", "support.use", "learning.consume"],
};

const ROUTE_CAPABILITY: Array<{ matches: (path: string) => boolean; capability: Capability }> = [
  { matches: (path) => path === "/admin", capability: "dashboard.admin.view" },
  { matches: (path) => path === "/teacher", capability: "dashboard.teacher.view" },
  { matches: (path) => path === "/instructor", capability: "dashboard.instructor.view" },
  { matches: (path) => path === "/student", capability: "dashboard.student.view" },
  { matches: (path) => path === "/registration-requests", capability: "registration.manage" },
  { matches: (path) => ["/students", "/offline-students", "/student-barcodes", "/student-reports", "/instructor-students"].includes(path), capability: "student.read" },
  { matches: (path) => ["/courses", "/subscriptions", "/course-content", "/teacher-content-manager"].includes(path), capability: "course.manage" },
  { matches: (path) => ["/grades", "/groups"].includes(path), capability: "group.manage" },
  { matches: (path) => ["/attendance", "/barcode-attendance", "/attendance-log", "/online-meeting"].includes(path), capability: "attendance.manage" },
  { matches: (path) => ["/fees", "/student-payments"].includes(path), capability: "billing.manage" },
  { matches: (path) => ["/messages", "/chat-assistant", "/student-chat", "/student-messages", "/student-ai-chat"].includes(path), capability: "message.use" },
  { matches: (path) => path === "/support", capability: "support.use" },
  { matches: (path) => path === "/reports", capability: "report.view" },
  { matches: (path) => ["/expenses", "/imports", "/account-statement", "/profits"].includes(path), capability: "expense.manage" },
  { matches: (path) => path === "/staff", capability: "staff.manage" },
  { matches: (path) => path === "/admin/instructors", capability: "instructor.manage" },
  { matches: (path) => path.startsWith("/admin/instructors/"), capability: "instructor.manage" },
  { matches: (path) => path === "/admin/operations", capability: "task.read" },
  { matches: (path) => path === "/admin/platform", capability: "subscription.read" },
  { matches: (path) => path === "/admin/approvals", capability: "approval.read" },
  { matches: (path) => path === "/admin/team", capability: "admin.roles.manage" },
  { matches: (path) => path === "/admin/finance" || path.startsWith("/admin/analytics/"), capability: "finance.read" },
  { matches: (path) => path === "/admin/security", capability: "security.read" },
  { matches: (path) => ["/teacher-lectures", "/teacher-premium-lectures", "/instructor-lectures", "/instructor-video-requests"].includes(path), capability: "video.manage" },
  { matches: (path) => path === "/instructor-wallet", capability: "wallet.view" },
  { matches: (path) => path === "/instructor-subscription", capability: "subscription.self.read" },
  { matches: (path) => ["/teacher-exams", "/exam-results", "/manual-grading"].includes(path) || path.startsWith("/teacher/exams/") || path.startsWith("/exam-reports/"), capability: "exam.manage" },
  { matches: (path) => path.startsWith("/student-") || path === "/exam-access" || path.startsWith("/take-exam/") || path.startsWith("/exam-review/"), capability: "learning.consume" },
];

const isLegacyRole = (role?: string): role is LegacyRole =>
  role === "admin" || role === "teacher" || role === "instructor" || role === "staff" || role === "student";

export function getEffectiveCapabilities(profile: AccessProfile | null | undefined): Set<string> {
  if (profile?.admin_member && Array.isArray(profile.admin_permissions)) {
    const mapped: Record<string, Capability> = {
      "admin.dashboard.read": "dashboard.admin.view",
      "instructor.read": "instructor.manage",
      "instructor.detail.read": "instructor.detail.read",
      "task.read": "task.read",
      "platform_payment.read": "subscription.read",
      "subscription.read": "subscription.read",
      "approval.read": "approval.read",
      "admin_roles.manage": "admin.roles.manage",
      "finance.read": "finance.read",
      "security.read": "security.read",
      "support.read": "support.use",
    };
    return new Set(profile.admin_permissions.map((key) => mapped[key]).filter((key): key is Capability => Boolean(key)));
  }
  const explicit = profile?.effective_permissions ?? profile?.permissions;
  if (Array.isArray(explicit)) return new Set(explicit);

  const result = new Set<string>();
  if (isLegacyRole(profile?.role)) {
    ROLE_CAPABILITIES[profile.role].forEach((capability) => result.add(capability));
  }

  if (profile?.role === "staff") {
    if ((profile.accessible_pages ?? []).length > 0) {
      result.add("dashboard.teacher.view");
    }
    (profile.accessible_pages ?? []).forEach((page) => {
      LEGACY_PAGE_CAPABILITIES[page]?.forEach((capability) => result.add(capability));
    });
  }

  return result;
}

export function can(profile: AccessProfile | null | undefined, capability: Capability): boolean {
  const permissions = getEffectiveCapabilities(profile);
  return permissions.has("*") || permissions.has(capability);
}

export function capabilityForPath(path: string): Capability | undefined {
  return ROUTE_CAPABILITY.find((policy) => policy.matches(path))?.capability;
}

export function canAccessRoute(profile: AccessProfile | null | undefined, path: string): boolean {
  if (profile?.role === "instructor" && profile.billing_only) {
    return ["/instructor-subscription", "/instructor-wallet", "/support"].includes(path);
  }
  // Platform admins oversee instructors; a wildcard/legacy role must not turn
  // the administrator into a teacher or an individual instructor.
  if ((profile?.role === "admin" || profile?.admin_member) && !(["/admin", "/admin/instructors", "/admin/operations", "/admin/platform", "/admin/approvals", "/admin/team", "/admin/finance", "/admin/security", "/support"].includes(path) || path.startsWith("/admin/instructors/") || path.startsWith("/admin/analytics/"))) {
    return false;
  }
  const required = capabilityForPath(path);
  return required ? can(profile, required) : false;
}

export function defaultRouteFor(profile: AccessProfile | null | undefined): string {
  if (profile?.role === "instructor" && profile.billing_only) return "/instructor-subscription";
  if ((profile?.role === "admin" || profile?.admin_member) && can(profile, "dashboard.admin.view")) return "/admin";
  if (can(profile, "dashboard.student.view") && profile?.role === "student") return "/student";
  if (can(profile, "dashboard.teacher.view")) return "/teacher";
  if (can(profile, "dashboard.instructor.view")) return "/instructor";
  return "/";
}
