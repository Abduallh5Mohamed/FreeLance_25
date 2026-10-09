# سجل المخاطر للمنتج الكامل

| # | الخطر | الأثر | التخفيف/دليل الإغلاق |
|---:|---|---|---|
| 1 | IDOR بين tenants | تسرب طلاب/درجات/ملفات | M1 ownership invariants واختبار API A→B |
| 2 | tenant backfill غير موثوق | خلط بيانات تاريخية | quarantine، provenance، reconciliation وrestore |
| 3 | auth split بين users/staff | privilege/session confusion | identity consolidation، revoke، migration contracts |
| 4 | self-assign admin / role legacy | takeover | signup allowlist، admin invitation، tests |
| 5 | secrets/history leakage | account compromise | rotate credentials, remove fallbacks, secret scan |
| 6 | runtime DDL/مسارات هدم | فقد/فساد بيانات | migrations versioned، منع destructive route، recovery test |
| 7 | impersonation إساءة | خصوصية وفقد ثقة | JIT approval, reason, time limit, banner, immutable audit |
| 8 | misuse student/parent data | كشف أطفال/بيانات حساسة | minimization, legal review, link verification, published-only fields |
| 9 | OTP abuse/SIM swap | account takeover/cost | throttles, expiry, one-time, alternate recovery, alerts |
| 10 | DRM/device incompatibility | وصول محروم/تسريب | device matrix, signed fallback policy, honest UX and support |
| 11 | live provider outage/cost | إلغاء حصة/تسجيل | POC, vendor escalation, fallback join/link, usage reconciliation |
| 12 | false automatic attendance | نزاع حضور | server event model, reconnect correction, teacher audit override |
| 13 | exam content/leak | أضرار أكاديمية | versioning, attempt policy, scoped questions, audit, rate limit |
| 14 | malicious assignment uploads | malware/data exfiltration | scan, size/mime quotas, quarantine, private storage |
| 15 | notification consent/spam | حظر رقم/مساءلة | opt-in purpose, unsubscribe, channel adapters, delivery logs |
| 16 | custom domain takeover/TLS | impersonation/cert issues | DNS challenge, ownership renewal, certificate lifecycle |
| 17 | inaccurate usage meter | خلاف عقد | immutable event ledger, definitions, reconciliation and export |
| 18 | gateway behavior/eligibility unknown | stuck enroll/refund | provider sandbox/contract verification, no invented behavior |
| 19 | outage/backup not restorable | prolonged data loss | separate encrypted backups and timed restore drills |
| 20 | capacity/feature interactions | slow/reliable regressions | load profiles, SLOs, job backpressure, staged rollout |
| 21 | export/integration leaks | cross-tenant data download | capability, audit, bounded export, signed artifact expiry |
| 22 | role/assistant drift | excess access | policy catalog, permissions version, action-specific tests |
| 23 | vendor lock-in and data residency | migration/legal barrier | provider adapters, data-processing register, export tests |
| 24 | feature toggles hide API access | insecure hidden endpoints | server-side entitlement and route authorization always enforced |
| 25 | growth promise exceeds evidence | reputation/churn | status-by-evidence, release notes and verified claims only |
