# Human192: retain WorkBuddy NEW lane; investigate native bundled CLI

Direct human2026-10-21 explicitly rejects191 OpenCode-for-new alternative and asks
Codex to try WorkBuddy CLI for new tasks. Human180 roles remain WorkBuddy NEW /
OpenCode CORRECTIONS; no transfer or broader product authority. Latest request
allows investigation of the INSTALLED WorkBuddy-specific CLI engine; no unrelated
CodeBuddy standalone install/substitution, credential extraction or bypass.

Observed native M2-11 owner workbuddy-native-m2-11-csv-resolution-20261021 initially
claimed; no second implementation run launched. It subsequently reported and
worker071-m2-11-csv-resolution-and-json-report-implemented-tested-reported.md exists.
This is submission only, still needs independent Codex source/tests review.

Public installed package @genie/agent-cli exposes bin/codebuddy. Its default CLI
bootstrap fails MODULE_NOT_FOUND ../dist/codebuddy because the app ships only
WorkBuddy-specific dist/codebuddy-lite-wb.mjs, not generic full/TUI bundle. Wrapper
explicitly routes CODEBUDDY_FORCE_LITE_WB_BUNDLE=1 to that shipped engine. With this
correct variant, local --help succeeds exit0 and advertises print/ACP/MCP/default
permissions. No install, model/account fallback or secrets read used. The binary
is named CodeBuddy; do not relabel it as a separate standalone WorkBuddy product.

A local ACP initialize-only probe (NO session/prompt/model task/claim) using that
variant exited0 without JSON-RPC initialize response. Therefore actual unattended
task dispatch is NOT verified. No repeated unchanged failure, second task owner,
blind native keys/private IPC or -y/bypassPermissions/global tool approval.
Headless/default-permission compatibility and legitimate account authentication
must be verified before adopting a new unattended dispatcher; do not copy app
credentials to make it work or promise successful CLI task execution from --help.

Readiness metadata: D:/Automation/TabwebWorkers/workbuddy-cli-readiness.json.
No product source/task declaration/claim/schedule changed. Existing worker timer
disabled, Codex15min active. Do NOT keep asking human to paste messages or transfer
new tasks to OpenCode after this rejection. Next: review stable M2-11 submission,
then continue legitimate bounded CLI integration diagnostics. On quota/guard stop
once; no workaround. Keep actual test/dispatch/account limitations honest.

Official references reviewed: https://www.workbuddy.ai/docs/cli/headless and
https://www.workbuddy.ai/docs/cli/settings . They document CodeBuddy CLI (same
vendor), not proof that packaged lite-wb supports each standalone CLI mode.
