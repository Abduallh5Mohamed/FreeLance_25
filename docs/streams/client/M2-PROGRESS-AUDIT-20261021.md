# M2 progress audit — 2026-10-21

This is an engineering estimate against the acceptance rows in
`docs/17-full-feature-backlog.md` plus the M2 commercial commitments in the same
file and `docs/19-commercial-registration-wallet-agreement-ar.md`. It counts
accepted behavior, not files, tests or task IDs. Migrations that exist only as
files do not count as runtime rollout. OTP is recorded as deferred, not complete.

## Core teacher/student scope (C1–C12): about 34%

| Item | Estimate | Evidence and principal remainder |
|---|---:|---|
| C1 identity/branches | 65% | profile/name/branch API+UI foundations accepted; migration rollout, assignment and full branch RBAC remain |
| C2 branding/subdomain | 35% | private localized branding foundation accepted; logo/assets, host resolution and global locale/theme remain |
| C3 custom domains | 0% | DNS ownership, TLS lifecycle and provider proof absent |
| C4 public discovery | 10% | private catalog exists; public projection/search/unpublished denial not accepted |
| C5 catalog | 70% | courses, units, lessons, ordering and private UI accepted; file validation/upload/video and full unpublished policy remain |
| C6 drip release | 0% | no accepted scheduled-release contract/runtime |
| C7 sequential unlock | 0% | no accepted prerequisite/progress enforcement |
| C8 terms/enrollment lifecycle | 45% | academic-period planning and existing enrollment pieces accepted; binding, transitions and audit integration remain |
| C9 signup/join | 55% | existing invitation/join slice accepted; OTP explicitly deferred and full verified-contact journey open |
| C10 access status | 35% | workspace boundaries exist; eligibility/expiry/revoke enforcement across every resource remains |
| C11 schedules/announcements | 20% | basic group schedule fields exist; timezone recurrence, announcements, audience and audit remain |
| C12 CSV/XLSX import | 70% | CSV parse/preview/decisions/report/reconciliation/review accepted; M2-16 commit is ready but unclaimed, XLSX remains |

Arithmetic mean: **33.8%**, rounded to **34%**. M2-16 is not counted until it is
implemented and independently accepted.

## Commercial M2 foundation (B1–B12/S10/F1): about 15%

Existing subscription, wallet, request and permission surfaces provide partial
foundations, but the accepted evidence does not yet establish safe self-signup and
checkout, the pricing equation and snapshots, same-center capability isolation,
online/offline activation and audience enforcement, balanced ledger/settlement,
96-hour grace, cash/refund handling, payouts, or the provider reconciliation gate.
No live provider or sandbox proof is authorized or claimed.

## Combined M2 estimate: about 25%

Giving equal top-level weight to the twelve C rows and twelve B rows yields roughly
**25% complete and 75% remaining**. A reasonable uncertainty band is **22–30%**
because several remaining financial/provider rows are substantially larger than a
single client feature. Counting only accepted task numbers would materially
overstate completion.

At the current large-batch size, the remaining code is unlikely to be fewer than
**12–18 substantial batches**, plus separately authorized migration rollout and
external/provider verification. M2-16 is the next batch but currently has no
verified WorkBuddy claim.
