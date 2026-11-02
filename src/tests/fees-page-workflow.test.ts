/**
 * Fees PAGE wiring — isolated production-path tests (node:test + tsx).
 *
 * Scope: the REAL `src/pages/Fees.tsx` payment form. The page module is loaded
 * unchanged except for three seams the test must own: its React hooks (so the
 * component can be invoked without a DOM and the real `processPayment`
 * callback can be captured), the `@/lib/api-http` transport, and the toast
 * sink. Everything else — the page's `loadFeesFromDB`, its `processPayment`
 * callback, the real `runPaymentFlow` it calls and the real amount gate — runs
 * as production code.
 *
 * This is the page-connection regression the 2026-10-26 audit asked for:
 * `loadFeesFromDB` used to swallow its own error, so the real page could never
 * reach `saved-refresh-failed` and a confirmed save with a failed list read
 * looked like a refreshed success. Here the refresh is driven by the REAL page
 * function (not an injected fake seam) and the toast/outcome is observed.
 *
 * Fully isolated: no DOM, no browser, no network, no database, no live service,
 * no dependency install.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));

interface FeeRow {
    id: string;
    amount: number;
    paidAmount: number;
    studentName: string;
    status: string;
    course: string;
    dueDate: string;
}

interface PageApiCalls {
    updates: { id: string; body: Record<string, unknown> }[];
    reads: boolean[];
    approvals: string[];
    deletes: string[];
}

interface ToastRecord {
    title?: string;
    description?: string;
    variant?: string;
}

interface PageHarness {
    submit: (event?: { preventDefault: () => void }) => Promise<unknown>;
    approve: () => Promise<unknown>;
    remove: () => Promise<unknown>;
    hasForm: boolean;
    calls: PageApiCalls;
    toasts: ToastRecord[];
    setterCalls: unknown[][];
}

const FEE: FeeRow = {
    id: "fee-1",
    amount: 300,
    paidAmount: 100,
    studentName: "طالب اختبار",
    status: "جزئي",
    course: "",
    dueDate: "2026-11-01",
};

const buildStates = (paymentAmount: string, options: ApiStubOptions): unknown[] => [
    [FEE], // fees
    [], // offlineFees
    [], // subscriptionRequests
    options.approvedRequests ?? [], // approvedRequests
    true, // isOpen
    false, // isAddNewOpen
    options.selectedRequest ? true : false, // isViewRequestOpen
    options.selectedRequest ?? null, // selectedRequest
    "", // searchTerm
    "all", // filterStatus
    10, // filterMonth
    2026, // filterYear
    [], // grades
    [], // groups
    { feeId: "fee-1", amount: paymentAmount, paymentMethod: "cash", notes: "" },
    {
        studentName: "",
        phone: "",
        guardianPhone: "",
        gradeId: "",
        groupId: "",
        barcode: "",
        totalAmount: "",
        paidAmount: "",
        notes: "",
    },
    false, // isSearchingStudent
    false, // isProcessingPayment
    null, // paymentImage
    null, // imagePreview
];

interface ApiStubOptions {
    failRefresh: boolean;
    failApprove?: boolean;
    failDelete?: boolean;
    refreshedOnline?: Record<string, unknown>[];
    selectedRequest?: Record<string, unknown> | null;
    approvedRequests?: Record<string, unknown>[];
}

const createApiStub = (calls: PageApiCalls, options: ApiStubOptions) => ({
    getGrades: async () => [],
    getGroups: async () => [],
    createFee: async () => ({}),
    updateFee: async (id: string, body: Record<string, unknown>) => {
        calls.updates.push({ id, body });
        return { id, ...body };
    },
    getFees: async (offline: boolean) => {
        calls.reads.push(offline);
        if (options.failRefresh) throw new Error("list read failed");
        return offline ? [] : (options.refreshedOnline ?? []);
    },
    getStudentByPhone: async () => null,
    getStudentById: async () => null,
    getStudents: async () => [],
    getSubscriptionRequests: async () => [],
    approveSubscriptionRequest: async (id: string) => {
        calls.approvals.push(id);
        if (options.failApprove) throw new Error("approve failed");
        return {};
    },
    rejectSubscriptionRequest: async () => ({}),
    deleteFee: async (id: string) => {
        calls.deletes.push(id);
        if (options.failDelete) throw new Error("delete failed");
        return undefined;
    },
    cleanupApprovedRequestsByMonth: async () => ({ deletedCount: 0 }),
});

const findSubmit = (node: unknown): ((event: { preventDefault: () => void }) => unknown) | null => {
    if (Array.isArray(node)) {
        for (const child of node) {
            const found = findSubmit(child);
            if (found) return found;
        }
        return null;
    }
    const element = node as { type?: unknown; props?: Record<string, unknown> } | null;
    if (!element?.props) return null;
    if (element.type === "form" && typeof element.props.onSubmit === "function") {
        return element.props.onSubmit as (event: { preventDefault: () => void }) => unknown;
    }
    return findSubmit(element.props.children);
};

interface RenderElement {
    type?: unknown;
    props?: Record<string, unknown>;
}

const findClickHandler = (
    node: unknown,
    predicate: (element: RenderElement) => boolean,
): ((...args: unknown[]) => unknown) | null => {
    if (Array.isArray(node)) {
        for (const child of node) {
            const found = findClickHandler(child, predicate);
            if (found) return found;
        }
        return null;
    }
    const element = node as RenderElement | null;
    if (!element?.props) return null;
    if (typeof element.props.onClick === "function" && predicate(element)) {
        return element.props.onClick as (...args: unknown[]) => unknown;
    }
    return findClickHandler(element.props.children, predicate);
};

const APPROVE_REQUEST: Record<string, unknown> = {
    id: "request-1",
    student_name: "طالب اشتراك",
    phone: "",
    grade_name: "",
    group_name: "",
    amount: 150,
    created_at: "2026-10-05T00:00:00.000Z",
};

const APPROVED_REQUEST: Record<string, unknown> = {
    id: "approved-1",
    student_name: "طالب محذوف",
    phone: "",
    grade_name: "",
    group_name: "",
    amount: 150,
    created_at: "2026-10-05T00:00:00.000Z",
    updated_at: "2026-10-05T00:00:00.000Z",
};

const REFRESHED_FEE_ROW: Record<string, unknown> = {
    id: "fee-1",
    amount: 300,
    paid_amount: 250,
    status: "partial",
    student_name: "طالب اختبار",
    grade_name: "",
    due_date: "2026-11-01",
};

const loadPageHarness = (paymentAmount: string, options: ApiStubOptions): PageHarness => {
    const projectRequire = Module.createRequire(import.meta.url);
    const React = projectRequire("react");
    const feesPath = projectRequire.resolve("../pages/Fees.tsx");
    const moduleInternals = Module as unknown as { _load: (...args: unknown[]) => unknown };
    const original = moduleInternals._load;
    const previousReact = (globalThis as { React?: unknown }).React;

    const calls: PageApiCalls = { updates: [], reads: [], approvals: [], deletes: [] };
    const toasts: ToastRecord[] = [];
    const states = buildStates(paymentAmount, options);
    const setterCalls: unknown[][] = states.map(() => []);
    let hookIndex = 0;

    const apiStub = createApiStub(calls, options);

    try {
        moduleInternals._load = function (
            specifier: string,
            parent: { filename?: string } | undefined,
            isMain: boolean,
        ) {
            if (specifier === "react" && /Fees\.tsx$/.test(parent?.filename || "")) {
                return {
                    ...React,
                    useState: () => {
                        const index = hookIndex++;
                        return [states[index], (next: unknown) => setterCalls[index].push(next)];
                    },
                    useRef: () => ({ current: false }),
                    useEffect: () => undefined,
                };
            }
            if (specifier === "@/lib/api-http") return apiStub;
            if (specifier === "@/components/ui/use-toast") {
                return { useToast: () => ({ toast: (record: ToastRecord) => toasts.push(record) }) };
            }
            // Static presentation assets are not part of this Node-only wiring
            // test; never let Node try to parse a PNG/CSS file as JavaScript.
            if (/\.(png|jpe?g|gif|svg|webp|avif|ico|css)$/i.test(specifier)) return "";
            if (specifier.startsWith("@/")) {
                return original.call(this, path.resolve(SRC_ROOT, specifier.slice(2)), parent, isMain);
            }
            return original.apply(this, [specifier, parent, isMain] as unknown[]);
        } as never;

        // Every harness gets a fresh module instance so the FIRST payment amount
        // under test is the one the captured callback sees.
        delete projectRequire.cache[feesPath];
        const Component = projectRequire(feesPath).default as (...args: unknown[]) => unknown;
        (globalThis as { React?: unknown }).React = React;
        const tree = Component({});
        const onSubmit = findSubmit(tree);
        const approveOnClick = findClickHandler(tree, (element) => {
            const className = element.props?.className;
            return typeof className === "string" && className.includes("bg-green-600 hover:bg-green-700");
        });
        const deleteOnClick = findClickHandler(tree, (element) => element.props?.title === "حذف");
        return {
            hasForm: onSubmit !== null,
            calls,
            toasts,
            setterCalls,
            submit: async (event = { preventDefault: () => undefined }) => {
                assert.ok(onSubmit, "the production payment form must exist");
                return onSubmit(event);
            },
            approve: async () => {
                assert.ok(approveOnClick, "the production approve handler must be bound");
                return approveOnClick({});
            },
            remove: async () => {
                assert.ok(deleteOnClick, "the production delete handler must be bound");
                const holder = globalThis as { confirm?: unknown };
                const previousConfirm = holder.confirm;
                holder.confirm = () => true;
                try {
                    return await deleteOnClick({});
                } finally {
                    holder.confirm = previousConfirm;
                }
            },
        };
    } finally {
        moduleInternals._load = original;
        if (previousReact === undefined) delete (globalThis as { React?: unknown }).React;
        else (globalThis as { React?: unknown }).React = previousReact;
    }
};

test('page: a confirmed write with a FAILED list refresh reports the distinct saved-refresh-failed toast', async () => {
    const harness = loadPageHarness("150", { failRefresh: true });
    assert.equal(harness.hasForm, true, "the production payment form is wired");

    await harness.submit();

    assert.equal(harness.calls.updates.length, 1, "exactly one real payment write");
    assert.equal(harness.calls.updates[0].id, "fee-1");
    assert.deepEqual(harness.calls.updates[0].body, {
        paid_amount: 250,
        status: "partial",
        payment_date: new Date().toISOString().split("T")[0],
        payment_method: "cash",
        notes: "",
    });
    assert.equal(harness.calls.reads.length, 2, "the REAL page loader read both fee lists");
    assert.equal(harness.toasts.length, 1);
    assert.equal(harness.toasts[0].title, "تم حفظ الدفعة", "the save is confirmed, not reported as a failure");
    assert.match(String(harness.toasts[0].description), /تعذر تحديث القائمة/);
    assert.equal(harness.setterCalls[0].length, 0, "the list is NOT described as refreshed when the read failed");
});

test('page: a confirmed write with a SUCCESSFUL refresh updates the real list state', async () => {
    const harness = loadPageHarness("150", {
        failRefresh: false,
        refreshedOnline: [{
            id: "fee-1",
            amount: 300,
            paid_amount: 250,
            status: "partial",
            student_name: "طالب اختبار",
            grade_name: "",
            due_date: "2026-11-01",
        }],
    });

    await harness.submit();

    assert.equal(harness.calls.updates.length, 1);
    assert.equal(harness.calls.reads.length, 2);
    assert.equal(harness.toasts.length, 1);
    assert.equal(harness.toasts[0].title, "تم تسجيل الدفع بنجاح");
    assert.equal(harness.setterCalls[0].length, 1, "the refreshed rows were applied to the page state");
    const renderedRows = harness.setterCalls[0][0] as { id: string; paidAmount: number; status: string }[];
    assert.equal(renderedRows.length, 1);
    assert.equal(renderedRows[0].id, "fee-1");
    assert.equal(renderedRows[0].paidAmount, 250);
    assert.equal(renderedRows[0].status, "جزئي", "partial remains partial");
});

test('page: a malformed amount is refused by the REAL page before any transport write', async () => {
    for (const amount of ["12abc", "1.234", "1e3"]) {
        const harness = loadPageHarness(amount, { failRefresh: false });
        await harness.submit();

        assert.equal(harness.calls.updates.length, 0, `"${amount}" must not reach the transport`);
        assert.equal(harness.calls.reads.length, 0, "no list refresh follows a refused amount");
        assert.equal(harness.toasts.length, 1);
        assert.equal(harness.toasts[0].title, "مبلغ غير صالح");
        assert.equal(harness.toasts[0].variant, "destructive");
    }
});

test('page: a confirmed APPROVE with a FAILED list refresh is reported as accepted, not as a failed write', async () => {
    const harness = loadPageHarness("150", {
        failRefresh: true,
        selectedRequest: APPROVE_REQUEST,
    });

    await harness.approve();

    assert.equal(harness.calls.approvals.length, 1, "exactly one approval mutation, no retry");
    assert.equal(harness.calls.approvals[0], "request-1");
    assert.equal(harness.calls.reads.length, 2, "the REAL page loader attempted the refresh once");
    assert.equal(harness.toasts.length, 1);
    assert.match(String(harness.toasts[0].title), /تم قبول الطلب/, "the approval is confirmed");
    assert.match(String(harness.toasts[0].description), /تعذر تحديث القائمة/);
    assert.notEqual(harness.toasts[0].variant, "destructive", "no false failure toast");
    assert.equal(harness.setterCalls[0].length, 0, "the stale list is NOT presented as refreshed");
    assert.equal(harness.setterCalls[6].length, 1, "the dialog closes after the confirmed approval");
    assert.equal(harness.setterCalls[7].length, 1, "the selection is cleared after the confirmed approval");
});

test('page: a confirmed APPROVE with a SUCCESSFUL refresh updates the real list state', async () => {
    const harness = loadPageHarness("150", {
        failRefresh: false,
        selectedRequest: APPROVE_REQUEST,
        refreshedOnline: [REFRESHED_FEE_ROW],
    });

    await harness.approve();

    assert.equal(harness.calls.approvals.length, 1);
    assert.equal(harness.calls.reads.length, 2);
    assert.equal(harness.toasts.length, 1);
    assert.match(String(harness.toasts[0].title), /تم قبول الطلب/);
    assert.doesNotMatch(String(harness.toasts[0].description), /تعذر تحديث القائمة/);
    assert.equal(harness.setterCalls[0].length, 1, "the refreshed rows were applied to the page state");
});

test('page: a confirmed DELETE with a FAILED list refresh is reported as deleted, not as a failed write', async () => {
    const harness = loadPageHarness("150", {
        failRefresh: true,
        approvedRequests: [APPROVED_REQUEST],
    });

    await harness.remove();

    assert.equal(harness.calls.deletes.length, 1, "exactly one delete mutation, no retry");
    assert.equal(harness.calls.deletes[0], "approved-1");
    assert.equal(harness.calls.reads.length, 2, "the REAL page loader attempted the refresh once");
    assert.equal(harness.toasts.length, 1);
    assert.match(String(harness.toasts[0].title), /تم الحذف بنجاح/, "the deletion is confirmed");
    assert.match(String(harness.toasts[0].description), /تعذر تحديث القائمة/);
    assert.notEqual(harness.toasts[0].variant, "destructive", "no false failure toast");
    assert.equal(harness.setterCalls[0].length, 0, "the stale list is NOT presented as refreshed");
});

test('page: a confirmed DELETE with a SUCCESSFUL refresh updates the real list state', async () => {
    const harness = loadPageHarness("150", {
        failRefresh: false,
        approvedRequests: [APPROVED_REQUEST],
        refreshedOnline: [],
    });

    await harness.remove();

    assert.equal(harness.calls.deletes.length, 1);
    assert.equal(harness.calls.reads.length, 2);
    assert.equal(harness.toasts.length, 1);
    assert.equal(harness.toasts[0].title, "تم الحذف بنجاح");
    assert.doesNotMatch(String(harness.toasts[0].description), /تعذر تحديث القائمة/);
    assert.deepEqual(harness.setterCalls[0][0], [], "the refreshed empty list is applied");
});

test('page: a REFUSED approve reports the write failure and does not refresh or retry', async () => {
    const harness = loadPageHarness("150", {
        failRefresh: false,
        failApprove: true,
        selectedRequest: APPROVE_REQUEST,
    });

    await harness.approve();

    assert.equal(harness.calls.approvals.length, 1);
    assert.equal(harness.calls.reads.length, 0, "no refresh after a failed write");
    assert.equal(harness.toasts.length, 1);
    assert.equal(harness.toasts[0].title, "خطأ");
    assert.equal(harness.toasts[0].variant, "destructive");
    assert.equal(harness.setterCalls[0].length, 0);
    assert.equal(harness.setterCalls[6].length, 0, "the dialog stays open on a failed write");
});

test('page: a REFUSED delete reports the write failure and does not refresh or retry', async () => {
    const harness = loadPageHarness("150", {
        failRefresh: false,
        failDelete: true,
        approvedRequests: [APPROVED_REQUEST],
    });

    await harness.remove();

    assert.equal(harness.calls.deletes.length, 1);
    assert.equal(harness.calls.reads.length, 0, "no refresh after a failed write");
    assert.equal(harness.toasts.length, 1);
    assert.equal(harness.toasts[0].title, "خطأ");
    assert.equal(harness.toasts[0].variant, "destructive");
    assert.equal(harness.setterCalls[0].length, 0);
});
