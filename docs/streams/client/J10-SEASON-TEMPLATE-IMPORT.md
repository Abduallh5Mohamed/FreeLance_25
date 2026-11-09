# J10 — Season template mapping UI, BUILD-44

`SeasonCourseReuse` mounts `SeasonTemplateImport` for one target course from the
confirmed season creation receipt or a historical season record. No manual
tenant/course authority field. The panel is keyed by target and session fenced.

The user explicitly reads old-course templates, selects a template, types a
persisted revision number (never defaulted to newest), reads its refs, and reads
same-kind candidates from the new course. Every old ref needs an explicit unique
replacement. Existing target sources must be prepared separately; import does
not duplicate files or audience. Candidate pages replace one bounded page per
kind; selections from a previous page are identified as previous selections and
their fresh titles/audiences appear in the server review.

The user confirms the right to reuse the template/sources, chooses a new name,
reviews old title → new title/state/audience, then confirms saving. Source,
revision, name or mapping changes discard approval. An imported template is not
applied to a lesson, published or declared deliverable. The original library is
read separately for current state.

Canonical relative authenticated no-store API calls validate exact DTOs and
target/revision/mapping bindings. The controller owns principal/session/epoch/
disposal/25-second fences. Changing account/workspace hides private state.

Before POST a minimal account-keyed sessionStorage marker records operation,
target-course, source-template, revision and reference count only. It contains
no mappings/titles/content/review token/auth token. Storage refusal prevents
request. Unknown outcome blocks writes/selection and outer season actions;
reopening offers only GET recovery. Missing/mismatched receipt remains blocked.
Closing/unmounting leaves the marker for recovery instead of assuming abort
means rollback. A confirmed receipt survives refresh/marker cleanup failure.

Local tests include actual panel callbacks and lost-write recovery transport.
Installed Chrome used the actual history button, explicit version and replacement,
review/confirmation, one POST and original library metadata read. Material
metadata only; no genuine PDF transfer, other-kind browser acceptance, mobile
or load claim.
