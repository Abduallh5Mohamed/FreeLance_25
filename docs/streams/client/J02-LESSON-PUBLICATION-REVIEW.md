# J02 — owner lesson package reference review (BUILD-57)

Mounted inside `LessonPackageTemplates` in existing course details, without editing the reserved lesson manager. Collapsed by default; no extra source requests until opened. Uses the existing bounded source chooser and `lessonPackageReader`: four independent authorized reads plus one conditional quiz-pin read. No new API, client identity authority, publication mutation or provider call.

Select unit/lesson explicitly. Rows cover material, video, homework, quiz and announcement. Draft/unavailable sources, unfinished video and missing/mismatched published quiz pin are known blockers. Restricted audience is a review requirement. Materials lack complete delivery/publication evidence in this DTO, so remain unverified. A ready video means processing status only; it never proves current student session/media delivery. Published homework still requires private storage and trusted scanning. Announcement publication never proves student visibility or notification delivery.

There is deliberately no ready-to-publish badge or synthetic student preview. Existing lesson release/prerequisite/course-publication editors remain authoritative; fresh actual student reads remain necessary. Independent reads are not one atomic publication snapshot. No access or financial policy changes.

Controller binds principal/session, request generation, disposal and 25-second UI deadline; any source failure clears the complete previous result. Collapse unmounts private state; no background polling or persisted source details. Text is rendered through normal React escaping.

[BUILD-57](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-08-BUILD-57.md) records five model/controller tests, native owner/student routes and a 390px Chrome viewport smoke (painted text hit-test, no overflow inside result, zero catalog writes, collapse removes data). Not actual-device/load/provider acceptance.
