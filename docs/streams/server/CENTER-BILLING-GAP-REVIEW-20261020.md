# Center billing — read-only gap review (2026-10-20)

**Task:** `server-center-billing-gap-review-20261020-01` · worker `wb-server-center-billing-gap-review-20261020-01` · team `backend`
**Mode:** READ-ONLY source audit. One file written (this report). No code, test, migration, schema, DB, Docker, network or Git write was performed.
**Repo:** `C:\Users\abdua\OneDrive\سطح المكتب\FreeLance_25-1` · branch `codex/workbuddy-server` · HEAD `03b7707` · working tree already dirty (95 entries) — preserved, nothing staged or reverted.
**Governing requirement set:** `docs/17-full-feature-backlog.md`, `docs/19-commercial-registration-wallet-agreement-ar.md`, and the owner rule restated in the task scope. Prices, tiers and eligibility policy were **not** invented; where no contract exists it is reported as absent.

---

## 0. Verdict in one paragraph

A SaaS **plan-price** billing path exists (platform plans → tenant subscription → manually verified payment → wallet/credit → renewal). A **student tuition** path exists (per-course subscriptions, monthly `student_fees`, payment requests). **The invoice basis required by the owner rule does not exist in any form**: there is no invoice table, no billing-period table, no usage/count snapshot, no proration, no rounding rule, and no query that counts unique students for billing. `tenant_subscriptions.agreed_price` is copied from `platform_plans.price`, so a center is charged a flat plan price regardless of enrolment count. The unique-student rule is therefore **ABSENT**, not partially implemented. Because no billing computation consumes enrolment rows, the absence is a **capability gap, not a reachable billing vulnerability** — except in the student-tuition layer, where four confirmed collection-integrity defects can misattribute or double-record a payment.

---

## 1. What exists today (module map)

### 1.1 Platform (SaaS) billing — the money the center pays Tabweb

| Concern | Where | Notes |
|---|---|---|
| Plan catalogue | `server/src/routes/platform-tenants.ts:74-116`; table `platform_plans` in `server/migrations/20260921_saas_foundation.sql:29-40` | `price DECIMAL(12,2)`, `duration_months`, `duration_days`. One flat price per plan. No tier/step fields. |
| Second, unrelated plan catalogue | `server/src/routes/subscription-plans.ts:66-68`; `subscription_plans` in `server/freelance_clean.sql:1091-1101` | Global (no `tenant_id`), used by legacy student `subscriptions`. Not linked to `platform_plans`. |
| Tenant subscription | `server/src/routes/platform-tenants.ts:469-474` (onboarding), `:517-520` (renewal); table `tenant_subscriptions` at `20260921_saas_foundation.sql:42-66` | `agreed_price`, `discount_amount`, `starts_at`, `period_ends_at`, `grace_until`, `cancel_at_period_end`. No `invoice_id`, no `price_version`, no `student_count`. |
| Payment submission | `server/src/routes/platform-tenants.ts:537-583` | `Idempotency-Key` header + `UNIQUE (subscription_id, idempotency_key)` (`20260921_saas_foundation.sql:86`). Manual reference number; no provider call. |
| Payment verification | `server/src/routes/platform-tenants.ts:585-652` | Human admin review; segregation of duties at `:612-614`; amount floor check at `:615`; period computed at `:627-637`. |
| Renewal execution | `server/src/services/subscription-renewal.ts:12-86` | Wallet debit + new subscription row + `platform_revenue_events` row, all in one transaction. |
| Wallet / service credit | `server/src/services/service-credit.ts:13-70`; table created in `20260924_instructor_topups_auto_renewal.sql:4-12` | `balance DECIMAL(12,2)`; `UNIQUE (instructor_id,type,reference_type,reference_uuid)` at `:12`. |
| Top-ups | `server/src/routes/tenant-self.ts:155-210`; verification at `server/src/routes/platform-tenants.ts:716-777` | Proof upload (SHA-256, unique), idempotency key, single pending renewal intent. |
| Lifecycle (grace/expiry) | `server/src/services/subscription-lifecycle.ts:29-98`, scheduled every 60 s at `server/src/index.ts:382-389` | 4-day grace (`:39`, `:52-55`); notifications; audit event. |
| Revenue recognition | `platform_revenue_events` at `20260924_instructor_topups_auto_renewal.sql:88-103`; written at `subscription-renewal.ts:66-71` | One row per renewal; `UNIQUE (subscription_id,event_type)` at `:101`. |
| Access gating | `server/src/security/principal-repository.ts:116-135`; `server/src/middleware/auth.ts:164-174` | Subscription state → `billingOnly` → 403 except billing/support paths (`auth.ts:94-101`). |
| Self-service view | `server/src/routes/tenant-self.ts:99-153` | Subscription, wallet, pending intent, top-ups. |

### 1.2 Student tuition — the money the student pays the center/teacher

| Concern | Where | Notes |
|---|---|---|
| Per-course student subscription | `server/src/routes/subscriptions.ts:188-324`; table `subscriptions` at `server/freelance_clean.sql:1169-1189` | `(student_id, course_id, amount, status)`. No period columns, no unique key, no tenant column (tenancy derived via `students` join, `subscriptions.ts:143-146`). |
| Monthly fee receipts | `server/src/routes/fees.ts:332-513`; table `student_fees` at `server/migrations/20260928_runtime_schema_replacement.sql:14-44` | `amount`, `paid_amount`, `status`, `payment_year`, `payment_month`; `UNIQUE (tenant_id,student_id,payment_year,payment_month)` at `:42`. |
| Online payment request → fee | `server/src/routes/payment-requests.ts:273-333` | Guarded flip + `FOR UPDATE`; writes `student_fees` **and** `revenues` (`:314-322`). |
| Subscription request → fee | `server/src/routes/subscription-requests.ts:211-348` | Guarded flip + `FOR UPDATE`; writes `student_fees` **only** (`:295-300`). |
| Cash ledger | `revenues` at `20260928_runtime_schema_replacement.sql:46-58`; `expenses` route mounted at `index.ts:224` | Flat amount/date rows. `revenues` router is **not mounted** — no `revenues` import or `app.use` in `server/src/index.ts`. |

### 1.3 Enrolment / eligible relationship

- A student-in-tenant **is one row** in `students`: `tenant_id`, `user_id`, single `instructor_id`, single `group_id`, `approval_status`, `is_active`, plus `enrollment_status` / `enrollment_start_date` / `enrollment_end_date` (`server/migrations/20261018_01_m2_identity_catalog_enrollment.sql:66-72`; `20260925_01_student_tenant_enrollment.sql:4-7`).
- Hard uniqueness: `UNIQUE (tenant_id,user_id)` (`20260925_01_student_tenant_enrollment.sql:40`).
- Eligibility predicate (status + half-open window) is duplicated in at least 12 SQL sites, e.g. `server/src/security/principal-repository.ts:137-148`, `server/src/routes/content-access.ts:256-267`, `server/src/routes/assignments.ts:268-277`.
- Enrolment approval creates or reuses that single row (`server/src/routes/student-enrollment.ts:556-578`). The lifecycle handler updates status/dates only (`:847-950`); a hermetic test asserts payment fields are **ignored** there (`server/tests/m2-c8-c10-enrollment-lifecycle.test.ts:202`).
- **No relationship/interval history table exists.** `enrollment_start_date`/`enrollment_end_date` are mutable columns on the row; there is no event log from which a union of intervals could be reconstructed.

### 1.4 Analytics that look like an invoice basis

| Surface | Where | What it counts |
|---|---|---|
| Finance summary | `server/src/routes/admin-insights.ts:86-90` | `COUNT(DISTINCT s.id)` — distinct enrolment rows, not users, not per tenant. |
| Instructor portfolio | `server/src/routes/admin-insights.ts:140-148`, returned at `:190` | `SUM(student_count)` over **per-instructor** counts. 3 teachers × 200 students = **600**. |
| Account statement | `server/src/routes/platform-tenants.ts:194-201`, returned at `:329-332` | Per-owner `COUNT(*) FROM students WHERE instructor_id=?` returned in the **same payload** as subscription amounts and `billing_profile`. |
| Instructor list | `server/src/routes/instructors.ts:49-51`, `:177` | Per-instructor `total_students` next to `wallet_balance`. |

---

## 2. The owner rule, tested against the code

Rule (verbatim from `docs/17:3`, `docs/19:39,41-50`): a center student is **one unique user within a tenant**, charged **once** while **any** eligible relationship is active; several teachers must not multiply the charge; overlapping active intervals are a **union**, not a sum; there is **no** dedup across independent tenants.

| # | Sub-rule | Status | Evidence |
|---|---|---|---|
| R1 | One unique student user per tenant is the billing unit | **ABSENT** | No billing code reads enrolment. Price is `platform_plans.price` → `agreed_price` (`platform-tenants.ts:445-448,469-474,517-520`). No `student_count` column anywhere in `server/migrations`. |
| R2 | Multiple teachers do not multiply the charge | **ABSENT (vacuously true)** | Nothing counts teachers. But the *only* number that could be misused, `instructor_portfolio.students`, sums per-teacher counts (`admin-insights.ts:140-148`) and would report 600 for 200 students. |
| R3 | Overlapping active intervals are a union | **ABSENT + structurally impossible today** | One row per `(tenant_id,user_id)` (`20260925_01:40`) with one `instructor_id` and one window. There is no second interval to union, and no interval history. |
| R4 | No cross-tenant dedup | **ABSENT (vacuously true)** | No dedup exists at all. Distinct tenants are distinct rows via `tenant_id`. |
| R5 | Analytics ≠ invoice basis | **CONFLATED in three read surfaces** | `admin-insights.ts:140-148/190`, `platform-tenants.ts:194-201/329-332`, `instructors.ts:49-51`. Same per-teacher query family, labelled as student counts, adjacent to money fields. No `invoice_basis` field distinguishes them. |
| R6 | Chargeable status derived from enrolment / active relationships | **ABSENT for billing; access-only** | Eligibility is computed only for content access (`principal-repository.ts:137-148`, `content-access.ts:256-267`). Nothing feeds it into money. |

**Counterexamples (concrete, from code paths, not executed):**

1. **R1/R2** — Tenant T has 200 students and 3 teachers. `admin-insights` `instructor_portfolio` returns `students = 600` (`admin-insights.ts:140-148`). The invoice is a flat plan price, e.g. 7,000 (`docs/19:20`), so the correct 200 and the wrong 600 both produce 7,000 — the count is never consulted. The rule is unimplemented, not violated.
2. **R3** — Student S is in teacher A's group, then teacher B in the same center enrols S by phone. `student-enrollment.ts:556-568` finds the existing `(tenant,user)` row and returns it **without** attaching B's group; `subscription-requests.ts:245-290` reuses the row found by phone and keeps the original `instructor_id`. The second relationship is silently dropped, so "any eligible relationship active" can never be evaluated — and S is attributed to A forever.
3. **R5** — A finance reader opens `/api/admin/platform/instructors/:id/account` (`platform-tenants.ts:300-332`). The payload carries `teaching.students` (per-teacher count) and `summary.current_ends_at` / plan amounts in the same object. Nothing in the contract marks which number is billable.
4. **R6** — `lectures.ts:343-348` resolves a student by `phone` with **no** `tenant_id` filter. If the same phone exists in two tenants, the eligibility lookup can resolve the other tenant's row. Any billing derivation reusing this predicate would be cross-tenant ambiguous. (Access-path risk; billing does not reuse it today.)

---

## 3. Prioritised gaps

Legend — **evidence class:** `code` = read from source/schema on disk; `hermetic` = asserted by an existing hermetic test; `live` = verified against a running system (**none used**); `absent` = no implementation found. Every gap below is a **capability gap** unless explicitly marked *confirmed defect*.

### G1 — No invoice / ledger data model (P0, absent)

- **Requirement:** `docs/17:137` B7 (collection ledger + tenant wallet, balanced entries, dedupe, refund reconciliation); `docs/17:151` F1 (invoice/withdrawal/refund concurrency, ledger proof); `docs/19:56` (invoice = new-period advance + prior settlement + prior debt − credit; idempotency key per invoice; `tenant/billing_period/invoice_type` uniqueness); `docs/19:95-101` (three separated money accounts).
- **What exists:** `revenues` and `expenses` flat tables (`20260928_runtime_schema_replacement.sql:46-58`; `expenses` route mounted at `index.ts:224`). `platform_revenue_events` (`20260924:88-103`) is a recognition log, not an invoice.
- **Missing:** `invoice`, `invoice_line`, `billing_period`, `ledger_entry`, `platform_receivable`, `merchant_wallet`, `subscription_credit`. `grep -rn "invoice|billing_period|price_version|platform_receivable|merchant_wallet|subscription_credit|refund" server/migrations server/bootstrap` → **no matches**.
- **Evidence class:** absent (schema + code).
- **Counterexample:** a center renews twice; `tenant_subscriptions` holds two rows and `platform_revenue_events` two rows, but no document ties an amount to a period, so "invoice #N for period P" cannot be produced or audited.
- **Follow-up:** **FU-1** (below).

### G2 — Invoice basis is not derived from unique students; price is flat (P0, absent)

- **Requirement:** `docs/17:132` B2 (`200 students × 3 teachers = 200`), `docs/17:146` B10 (tier ladder 200/201/250/…; total never decreases), `docs/17:98` O3, `docs/19:19-23` (T(n)/C(n)), `docs/19:45-50` (four acceptance examples).
- **What exists:** `platform-tenants.ts:445-448` selects `price`; `:469-474` and `:517-520` copy it into `agreed_price`. `subscription-renewal.ts:49-57` reuses `charge_amount`. No `C(n)` / `T(n)` function exists.
- **Missing:** any function, table or job computing the billable count per tenant per period.
- **Evidence class:** absent. No test asserts the ladder (`grep -rn "2592000|prorat|HALF_UP" server/tests` → no billing-tier test).
- **Counterexample:** tenant with 351 students and tenant with 200 students both get `agreed_price` from the same plan row → identical invoice, contradicting `docs/19:23` (C(351)=13,000 vs C(200)=7,000).
- **Follow-up:** **FU-2**, **FU-3**.

### G3 — Active-relationship intervals cannot be modelled or unioned (P0, absent + structural)

- **Requirement:** `docs/17:146` B10 ("علاقات متعددة بعدّ الطالب الفريد … واتحاد الفترات النشطة لا جمعها"), `docs/17:160` F2 (events reconstructable), `docs/19:39,41-50,52`.
- **What exists:** one `students` row per `(tenant_id,user_id)` (`20260925_01:40`) with a single `instructor_id`, single `group_id`, and one mutable window (`20261018_01:66-72`).
- **Missing:** a `student_teacher_relationship` table with `(tenant_id,user_id,instructor_id,starts_at,ends_at,status,source)` and an append-only status-event log; a canonical "eligible now" predicate derived from it.
- **Evidence class:** absent (schema).
- **Counterexample:** see §2 counterexample 2. A second teacher cannot be represented; `student-enrollment.ts:645` even joins `groups` on `grp.instructor_id = s.instructor_id`, so after an attribution mismatch the student's workspace loses its group/branch.
- **Follow-up:** **FU-3**.

### G4 — Billing cycle, proration and rounding do not match the contract (P0, absent)

- **Requirement:** `docs/19:13` (fixed 30-day cycle from subscription start), `docs/19:52` (interval split, `duration_seconds / 2592000`), `docs/19:54` (`[start,end)` UTC; `2592000` s; `345600` s grace; one HALF_UP rounding to the piastre; **no JavaScript floating point**), `docs/17:151` F1 (50 then 51 after 15 days = 2025).
- **What exists:** calendar arithmetic — `DATE_ADD(DATE_ADD(?, INTERVAL ? MONTH), INTERVAL ? DAY)` (`platform-tenants.ts:634`, `subscription-renewal.ts:53`). Grace is a fixed `INTERVAL 4 DAY` (`subscription-lifecycle.ts:39,52-55`). No proration path: a mid-cycle plan change is not possible, and `cancel_at_period_end` simply yields `cancelled` with no closing settlement (`subscription-lifecycle.ts:49`).
- **Second, conflicting month definition:** `remainingDays / 30.4375` (`platform-tenants.ts:344`).
- **Missing:** one cycle-length constant, second-resolution interval math, HALF_UP rounding, settlement lines.
- **Evidence class:** absent.
- **Counterexample:** a 1-month plan starting 2026-01-31 ends 2026-02-28 (28 days) under `DATE_ADD … MONTH`, i.e. 2,419,200 s, not 2,592,000 s — a 6.7% shorter period for the same price. The `docs/19:52` example (2,000 + 50/720 = 2,000.07) is not computable by any code path.
- **Follow-up:** **FU-2**, **FU-1**.

### G5 — No price version snapshot; renewal re-reads the mutable plan price (P1, partial)

- **Requirement:** `docs/19:11` ("snapshot للسعر والعرض في الفاتورة"), `docs/19:56` ("تحفظ price_version"), `docs/17:125` ("نسخة السعر … قابلة للتدقيق"), `docs/17:134` B4 ("تغيير السعر لا يعدل الطلب السابق").
- **What exists:** `agreed_price` is snapshotted **per subscription row** — a real partial implementation for the current period. But there is no `price_version` / `plan_snapshot` and no history of `platform_plans.price` edits (`platform-tenants.ts:86-116` updates nothing today, but the column is mutable).
- **Missing:** immutable price version referenced by invoice lines; plan edit audit that preserves the historical price.
- **Evidence class:** code (partial).
- **Counterexample:** plan price edited between period N and N+1; renewal intent computes `charge_amount` from the live plan row (`tenant-self.ts:241` uses the subscription's `agreed_price`, but `platform-tenants.ts:505-520` uses the live plan `price`), so two renewal paths can charge different amounts for the same plan.
- **Follow-up:** **FU-4**.

### G6 — No refund, chargeback or dispute implementation (P1, absent)

- **Requirement:** `docs/17:148` B12, `docs/19:80-84` (request → funding check → reserve → provider → reversal entry), `docs/19:103-105`.
- **What exists:** the strings `refund_request` / `payment_dispute` as admin work-item **types** (`server/src/routes/admin-work-items.ts:45`) and `refund` as an impersonation-blocked keyword (`server/src/services/impersonation.ts:618`).
- **Missing:** refund entity, reserved-funds state, reversal ledger entry, provider reference. `grep -rn "refund|chargeback" server/migrations` → no matches.
- **Evidence class:** absent.
- **Counterexample:** a verified `platform_payment_attempts` row can only move `submitted → verified`; there is no transition to reversed, so a wrongly verified payment cannot be corrected except by inserting a negative manual row.
- **Follow-up:** **FU-5** (doc/contract only until owner policy is confirmed).

### G7 — No verified payment-provider callback (P1, absent; gap, not vulnerability)

- **Requirement:** `docs/17:131` B1 ("callback متكرر لا يكرر التفعيل"), `docs/17:151` F1 ("webhook مكرر/مزور ومبلغ خاطئ"), `docs/19:70` (provider contract required before claiming support).
- **What exists:** manual admin verification only (`platform-tenants.ts:585-652`, `:716-777`) with segregation of duties and an amount floor. The **only** signature-gated callback pattern in the repo is for video assets (`server/src/middleware/tenant-authority-boundary.ts:6-19`, `server/src/routes/video-assets.ts:17-21`) — no payment route.
- **Missing:** signed webhook endpoint, replay protection, amount/currency cross-check against the invoice.
- **Evidence class:** absent. **This is a gap, not a vulnerability**: no unauthenticated payment endpoint exists to forge.
- **Counterexample:** none reachable. The nearest risk is human: a verifier can approve any amount `>=` the amount due (`:615`), with no upper bound, so an overpayment is accepted silently and creates no credit note.
- **Follow-up:** **FU-6** (contract-only; blocked on vendor/owner).

### G8 — Money-account separation is absent (P1, absent)

- **Requirement:** `docs/19:95-101` (`platform_receivable` / `merchant_wallet` / `subscription_credit`; credit consumes the next invoice before wallet; one allocation per transaction), `docs/19:70` (balanced immutable ledger `pending_settlement/available/reserved`).
- **What exists:** `instructor_wallets.balance` (single scalar, `20260924:4-12`) + `instructor_wallet_transactions` (running balance, `service-credit.ts:61-67`); `revenues`/`expenses` as flat rows.
- **Missing:** account dimension, reservation, pending-vs-available states, allocation table.
- **Evidence class:** absent.
- **Counterexample:** `postServiceCreditEntry` credits the same scalar for cash top-ups and for compensation adjustments, so cash and credit are indistinguishable at read time (`tenant-self.ts:149` returns one `balance`).
- **Follow-up:** **FU-1**.

### G9 — Student fee collection has four confirmed integrity defects (P1, **confirmed defect**)

- **Requirement:** `docs/17:137` B7 (no double collection, balanced, dedupe), `docs/19:60` (cash receipt recorded, never increases withdrawable balance; price snapshot per request), `docs/17:134` B4.
- **Evidence class:** code (+ one hermetic test that does **not** cover these paths: `server/tests/finance-billing.test.ts:608-616` only asserts a 3-dp rejection).
- **Defect 9a — default `status='paid'` with `paid_amount=0`.** `fees.ts:475-477` writes `amount || 0`, `paid_amount || 0`, `status || 'paid'`. `POST /api/fees {student_name, amount: 500}` yields `amount=500, paid_amount=0, status='paid'`, `remaining_amount=500` (generated column, `20260928:28`). Counterexample: the month is now marked paid for that student, blocking the real receipt (`fees.ts:442-456`), while no money was recorded.
- **Defect 9b — fuzzy name linking attaches a receipt to the wrong student.** `fees.ts:404-415` matches `s.name LIKE '%name%' ORDER BY CHAR_LENGTH(s.name) ASC LIMIT 1`. Counterexample: students "محمد" and "محمد أحمد"; a receipt entered as "محمد" for the second student links to the first (shortest name), marking the wrong student paid for the month and allowing the right one to be charged again — a double collection for one student-month.
- **Defect 9c — pre-check vs unique key mismatch returns 500.** The duplicate guard only looks at `status='paid'` (`fees.ts:442-447`), but `UNIQUE (tenant_id,student_id,payment_year,payment_month)` (`20260928:42`) covers **all** statuses. A second *pending* fee for the same month violates the key; the catch-all at `fees.ts:509-512` returns `500 Failed to create fee`. Counterexample: insert a pending fee, then a second one → 500, not a 400/409 with a usable message.
- **Defect 9d — unlinked offline receipts bypass the month dedupe.** When no student matches, `resolvedStudentId = null` (`fees.ts:417-419`) and the row is inserted with `student_id NULL`. MySQL unique keys allow repeated NULLs, so unlimited "paid" rows for the same month/person can be created with no attribution. Counterexample: two cash receipts for the same walk-in student without barcode/phone → two paid rows, no dedupe, no link.
- **Follow-up:** **FU-7**.

### G10 — Student identity linkage is inconsistent across five creation paths (P1, **confirmed defect**)

- **Requirement:** `docs/17:132` B2 and `docs/19:39` require a **unique user** basis; `docs/19:41-50` acceptance examples assume one identity per student per tenant.
- **Evidence class:** code (schema + all five insert sites).
- **Detail:**

| Path | `user_id` | `tenant_id` | Citation |
|---|---|---|---|
| Enrolment approval | set | set | `student-enrollment.ts:570-578` |
| Staff-created student | set (`linkedUserId`) | set | `students.ts:365-369` |
| CSV import | **NULL** | set | `student-import.ts:294-301` |
| Subscription request approval | **NULL** | set | `subscription-requests.ts:282-290` |
| Legacy registration request | **NULL** | **NULL** | `registration-requests.ts:237-241` |

- **Counterexample:** `SELECT COUNT(DISTINCT user_id) FROM students WHERE tenant_id=?` returns 0 for a center whose students were all created through CSV import or subscription requests. A naive implementation of R1 would bill 0; a naive `COUNT(*)` would bill rows, including the NULL-tenant legacy rows, which cannot be scoped at all.
- **Follow-up:** **FU-7**.

### G11 — Online subscription approval writes a fee but no revenue (P2, **confirmed defect**)

- **Requirement:** `docs/17:137` B7 (one collection ledger reconciled with receipts), `docs/19:66` (all center collections enter the center wallet).
- **What exists:** `payment-requests.ts:314-322` writes `student_fees` **and** `revenues`; `subscription-requests.ts:295-300` writes `student_fees` only.
- **Evidence class:** code. `finance-billing.test.ts:685-694` asserts the fee row count but never asserts a revenue row.
- **Counterexample:** two approvals of the same 500 EGP amount through the two routes produce two fee rows and **one** revenue row; any revenue total derived from `revenues` understates collections by 50% on the subscription-request path.
- **Follow-up:** **FU-8**.

### G12 — Platform finance reader approving a tenant request stamps its own user id as `instructor_id` (P2, **confirmed defect**)

- **Requirement:** `docs/17:149` S10 (teacher X must not act as another tenant's teacher), `docs/19:7` (center resources are tenant-scoped; assignments confine a teacher to their students).
- **What exists:** `resolveScope` grants `platform: true` to any `finance.read` holder (`subscription-requests.ts:92-100`), and `approve` uses the same scope (`:213`) while inserting `instructor_id = scope.userId` (`:285`).
- **Evidence class:** code. `finance-billing.test.ts` approves with `OWNER_A` only; the platform path is untested.
- **Counterexample:** a super_admin approves tenant-a's request → new `students` row has `instructor_id = <admin uuid>` while `group_id` points to a tenant-a group. `student-enrollment.ts:645` joins `groups grp ON grp.id=s.group_id AND grp.instructor_id=s.instructor_id`, so the student's workspace loses group name and branch; `platform-tenants.ts:196` never counts the student under any tenant instructor; `fees.ts:181-183` matches only via the group branch.
- **Follow-up:** **FU-8**.

### G13 — Analytics/invoice conflation is latent but real (P2, **confirmed conflation**)

- **Requirement:** `docs/17:98` O3 (measurement and billing use the unique-student basis), `docs/17:103` O8 ("definitions/time windows match source ledger").
- **What exists:** `admin-insights.ts:140-148` sums per-instructor counts and returns them as `instructor_portfolio[].students` (`:190`), labelled `عدد الطلاب المرتبطين` (`:234`); `platform-tenants.ts:194-201/329-332` puts the per-teacher count inside the billing account statement.
- **Missing:** a distinct, labelled `invoice_basis` value computed as `COUNT(DISTINCT user_id)` per tenant, and a guard preventing the analytics number from being reused as a billable quantity.
- **Evidence class:** code.
- **Counterexample:** see §2 counterexample 1 (600 vs 200).
- **Follow-up:** **FU-9**.

### G14 — Idempotency race and float comparison in the payment path (P3, partial)

- **Requirement:** `docs/19:54` (no JavaScript floating point for money), `docs/17:151` F1 (concurrent invoice/payment must not double-apply).
- **What exists:** sequential retry is correct — `Idempotency-Key` + unique key (`platform-tenants.ts:542-560`, `20260921:86`); verification is guarded by status + `FOR UPDATE` (`:589-607`); renewal intent is unique-per-tenant while pending (`20260924:74`).
- **Defect:** two **concurrent** identical submits both pass the `SELECT` (`:555-560`) and one hits `ER_DUP_ENTRY`, which the catch at `:576-581` maps to `500` instead of returning the existing row. Money comparison at `:615` and `subscription-renewal.ts:35` uses `Number(...)`, contrary to the no-float rule; for 2-dp values inside `DECIMAL(12,2)` this does not produce a demonstrable wrong decision (no reachable counterexample found), so it is a rule violation, not a confirmed arithmetic bug.
- **Evidence class:** code; no hermetic test covers the concurrent case.
- **Follow-up:** **FU-10**.

### G15 — Observation: overlapping grace interpretation (P3, hypothesised)

`principal-repository.ts:123-124` already allows 4 extra days while status is `active`/`past_due`, and `subscription-lifecycle.ts:52-55` then sets `grace_period` with `grace_until = period_ends_at + 4 days`. The two windows are the same 4 days, so access length matches `docs/19:76` by coincidence of constants, but `past_due` gets the same extension although the doc ties grace to a shortfall request (`docs/19:76`). No money is computed, so this is an access-semantics observation only. **Hypothesised, not confirmed as a defect.**

---

## 4. Verified risks vs hypothesised risks

**Verified from source (file:line evidence above):**

1. No invoice/ledger/proration/refund code exists (G1, G4, G6).
2. Platform billing charges a flat plan price; the unique-student basis is never consulted (G2, R1–R4).
3. `students` cannot represent a second teacher relationship in the same tenant (G3).
4. Four fee-collection integrity defects (G9a–d).
5. Five creation paths disagree on `user_id`/`tenant_id` (G10).
6. Fee-without-revenue on the subscription-request path (G11).
7. Platform approver stamped as `instructor_id` (G12).
8. Per-teacher counts are exposed next to money fields (G13).
9. Three different "month" definitions: 30 days (doc), calendar months (`DATE_ADD … MONTH`), 30.4375 days (`platform-tenants.ts:344`).
10. Timezone: `server/src/db.ts:26` sets the mysql2 client `timezone: '+02:00'`, while billing SQL mixes `UTC_TIMESTAMP()` (periods, grace) with `NOW()`/`CURDATE()` (`payment-requests.ts:316,320`; `fees.ts:437-439,481-482` uses JS `new Date()` local parts). mysql2's `timezone` option does **not** set the MySQL session zone, so `CURDATE()` follows the DB server's zone — a third, statically unverifiable clock. Counterexample: a receipt at 2026-11-01 00:30 Cairo can land in month 10 or 11 depending on which path and which clock, and `uq_student_fee_month` cannot dedupe the two outcomes.
11. `revenues` has no read surface (router not mounted) while `expenses` does.

**Hypothesised only (no reachable evidence found):**

1. Two concurrent verifications could activate two subscriptions for one tenant — there is no unique constraint on "one active subscription per tenant"; `platform-tenants.ts:498` locks the tenant row only inside the renewal-request route, and the verify route does not re-check for an existing active row.
2. Float comparisons in `platform-tenants.ts:615` / `subscription-renewal.ts:35` could mis-decide sufficiency — no 2-dp counterexample exists within `DECIMAL(12,2)`.
3. Grace double-extension (G15).
4. `lectures.ts:343-348` phone-keyed eligibility is cross-tenant ambiguous — verified as code shape, but no billing consumer, so impact is access-only.

**Explicitly not claimed:** no price, tier, eligibility or provider behaviour was inferred. The ladder, the 30-day cycle and the 4-day grace are quoted from `docs/19`, not invented.

---

## 5. Proposed follow-up tasks (disjoint file sets)

All paths below are **new files** except FU-7, FU-8, FU-10, which necessarily touch shared routers and therefore need an exclusive claim window. The coordinator must confirm no active claim covers these exact paths; I did not inspect other tasks' `allowedPaths`.

| ID | Scope | `allowedPaths` | Depends on | Acceptance tests | Size |
|---|---|---|---|---|---|
| **FU-1** | Billing ledger schema + contract | `server/migrations/20261021_01_billing_ledger_schema.sql`, `docs/contracts/BILLING-LEDGER-CONTRACT.md` | owner confirmation of money-account policy (`docs/19:95-101`) | migration is idempotent/re-runnable; contract names every column, uniqueness key (`tenant_id,billing_period,invoice_type`) and the three accounts; no runtime DDL | M |
| **FU-2** | Pure charge-basis + proration module (no DB) | `server/src/services/billing/charge-basis.ts`, `server/tests/billing-charge-basis.test.ts` | none (pure) | `C(200)=7000`, `C(201)=7045`, `C(351)=13000`, `C(500)=17500`; `T(50)=2000`, `T(51)=2050`; 50→51 at day 15 = 2025; 51 for one hour = 2000.07 (HALF_UP, once); interval split with `[start,end)`; no float (integer minor units); overlap union; DST-independent | M |
| **FU-3** | Relationship model + eligible-interval union | `server/migrations/20261021_02_student_teacher_relationship.sql`, `server/src/services/billing/eligible-relationships.ts`, `server/tests/billing-eligible-relationships.test.ts` | FU-1 | backfill from `students` preserves today's single relationship; 3 teachers × 200 students → 200; teacher A ends while B active → count unchanged; last ends → drops; same user in two tenants → counted once per tenant; no cross-tenant dedupe | L |
| **FU-4** | Invoice issuance, price version, idempotency | `server/src/services/billing/invoice-issuance.ts`, `server/tests/billing-invoice-issuance.test.ts` | FU-1, FU-2, FU-3 | duplicate `Idempotency-Key` returns the same invoice; concurrent issuance creates one; price edit does not alter an issued invoice; invoice = advance + prior settlement + debt − credit; correction via compensating entry only | M |
| **FU-5** | Refund/dispute contract (doc only) | `docs/contracts/BILLING-REFUND-DISPUTE.md` | owner policy (`docs/19:80-84,103-105`) | document enumerates states, funding precondition, reservation, reversal link, chargeback path; explicitly marks provider behaviour unverified | S |
| **FU-6** | Payment-provider callback contract (doc only) | `docs/contracts/PAYMENT-PROVIDER-CALLBACK.md` | vendor/contract evidence | signature scheme, replay window, idempotency key, amount/currency cross-check, failure handling; states that no implementation is authorised yet | S |
| **FU-7** | Fee-collection integrity (G9, G10) | `server/src/routes/fees.ts`, `server/src/routes/subscription-requests.ts`, `server/src/routes/student-import.ts`, `server/tests/finance-fee-integrity.test.ts` | none | default status is `pending` not `paid`; `paid_amount>0` required for `paid`; ambiguous name match is rejected (no `LIKE … LIMIT 1`); duplicate month returns 409 before insert and under concurrency; unlinked receipts require explicit confirmation and cannot satisfy the month guard; every creation path sets `user_id`+`tenant_id` or is rejected | M |
| **FU-8** | Revenue parity + approver attribution (G11, G12) | `server/src/routes/subscription-requests.ts`, `server/tests/finance-subscription-request-parity.test.ts` | FU-7 (same file) | approval writes exactly one fee **and** one revenue row; retry writes none; platform-scope approval is rejected (403) or resolves a tenant instructor, never the admin id; student workspace keeps group/branch after approval | S |
| **FU-9** | Invoice-basis read model (G13) | `server/src/services/billing/invoice-basis-report.ts`, `server/tests/billing-invoice-basis-report.test.ts` | FU-3 | returns `invoice_basis = COUNT(DISTINCT user_id)` per tenant and `analytics.per_instructor` separately; the two are never derived from the same query; 200×3 → 200 vs 600 asserted explicitly | S |
| **FU-10** | Payment-path idempotency + decimal safety (G14) | `server/src/routes/platform-tenants.ts`, `server/tests/finance-payment-idempotency.test.ts` | coordinator sequencing (shared router) | concurrent duplicate submit returns the existing attempt (not 500); amount comparison done in SQL/DECIMAL; overpayment produces a credit note or is rejected | S |

**Not proposed:** any change that sets prices, tiers, eligibility or provider behaviour. FU-5/FU-6 are documentation only and stay blocked until the owner supplies the missing policy/vendor facts listed at `docs/19:90`.

---

## 6. Evidence inventory

**Commands run (all read-only):** `git branch --show-current`, `git status --porcelain`, `git rev-parse --short HEAD`, `ls`, `wc -l`, `grep`/`rg` via the search tool, `sha256sum`. No test, build, server, DB, Docker, migration, package or network command was executed.

**Source hashes at audit time (SHA-256):**

| File | SHA-256 |
|---|---|
| `server/src/routes/fees.ts` | `c51f5c94aa5a805d30fa3d32c1573dcf5a25a6b47621519a84a027d8920b56b1` |
| `server/src/routes/subscriptions.ts` | `40d4565d014c733e3bdad3825846bc582928b4993c2b8d51becd0700bc84f749` |
| `server/src/routes/platform-tenants.ts` | `1a9069336178968d04ed8acb40b5817b6f633998ed54b3b26f25fb500a6018cf` |
| `server/src/routes/tenant-self.ts` | `41e07ef052f5367be42930166b46399ac6e72ce32f142d3b997850a1e9888bfa` |
| `server/src/routes/subscription-requests.ts` | `cb544bda73d9c24b4775fae601922c4a3f8381ad8f9e74dc17cbc5f2d4c920bb` |
| `server/src/routes/payment-requests.ts` | `3872e5240693a77b2118193caae40d2973841be6caa473a2881270201a08c1e2` |
| `server/src/routes/admin-insights.ts` | `7201581af6b67da1d6395a7aeb80e05defac188122beb76fb8ac66882407c593` |
| `server/src/services/subscription-renewal.ts` | `c90b38ac40daf2812cc7d446bf72d8c099dd0a8f71e5d5badbc3292a9988b7b1` |
| `server/src/services/subscription-lifecycle.ts` | `7518b20943e33cf216d5d6f1d071f65b867c1f7a251bfedcb8440532513b6e7c` |
| `server/src/services/service-credit.ts` | `807b6a4bb491e065d330e6097c1750ef45e9de57c6fa8ad933425245bbecb12d` |
| `server/src/security/principal-repository.ts` | `b6d51ea7b86314f9f6fa3d80ffa6ae7f6befdf682153f96540038d63662aa7ef` |
| `server/migrations/20260921_saas_foundation.sql` | `6793fe14428b2e8ff734ab9a66e72aa2b425eb6e17b080277f064dc0e5a3409f` |
| `server/migrations/20260924_instructor_topups_auto_renewal.sql` | `9c3d5a92080d2b0a261ca77ceec214880dfc063b78069d2dfaa55b420d738138` |
| `server/migrations/20260928_runtime_schema_replacement.sql` | `8bda34c56251b61b7d9f2413d4f32240f46516730728455ff2de8da4ab8c359e` |
| `server/migrations/20260925_01_student_tenant_enrollment.sql` | `5e529626346a1fc0bc651e5b6612fc320eb9935c63ca196395ea588b3181f425` |
| `docs/17-full-feature-backlog.md` | `a08329c02beab20a77df371780c40615ae5f1f0e0ad55bf7d60cd9387ae0aa6c` |
| `docs/19-commercial-registration-wallet-agreement-ar.md` | `f5db1b5fd0efe2254e967c40df63fb9f8f9a087df1a2241f6f970b4a0061ac4f` |
| `server/tests/finance-billing.test.ts` | `117a71693cf21140c8e1b7519606c3543f9d5757d513a63995a34e0525cb5d0d` |

**Existing coverage relied on (read, not executed):** `server/tests/finance-billing.test.ts` (money validation `:567-626`, tenant isolation `:632-679`, approval idempotency `:685-727`), `server/tests/m2-c8-c10-enrollment-lifecycle.test.ts` (eligibility window, `:243-300`; payment fields ignored, `:202`), `server/tests/m1-expanded-finance-records.test.ts` (authority matrix).

**Limitations:** schema is read from authored migrations, not from a live database — column presence and index enforcement are **not** live-verified. `docs/07-payments-and-billing.md` is a 7-line stub and contributed nothing. No frontend was inspected (owned by the human developer). Dirty working tree means line numbers reflect the on-disk version at HEAD `03b7707` plus uncommitted edits by other workers.

---

## 7. Questions / blockers

1. **Cycle length.** `docs/19:13,54` fixes 30 days (2,592,000 s) and forbids calendar-month arithmetic, but `platform_plans` only carries `duration_months`/`duration_days` (`20260921:33-34`). Should a "30-day" plan be seeded as `duration_days=30`, or should the cycle constant override plan duration? FU-2 cannot pick one without this answer.
2. **Grace semantics.** Is the 4-day grace measured from `period_ends_at` (current code, `subscription-lifecycle.ts:52-55`) or from issuance of the shortfall request (`docs/19:76`)? They differ whenever a shortfall request is late.
3. **Count timing.** `docs/19:52` bills on count-change intervals. Does a student become billable at `enrollment_start_date`, at payment confirmation, or at approval? `docs/19:39` excludes `pending/rejected` and counts grace as active, but the code has no single event to anchor on (G3).
4. **Price versioning ownership.** FU-4 needs a decision on whether `platform_plans.price` stays mutable (with version rows) or becomes append-only.
5. **Shared-file sequencing.** FU-7/FU-8/FU-10 modify `fees.ts`, `subscription-requests.ts`, `platform-tenants.ts`, which other workers may hold. Coordinator must grant exclusive windows; I did not claim them.

**Status: reported.** This report is not an acceptance. All findings are proposals for Codex review.
