import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BookOpen, GraduationCap, Search } from "lucide-react";
import {
  PUBLIC_COURSE_SEARCH_MAX,
  createProductionPublicCourseDiscoveryController,
  type PublicCourse,
  type PublicCourseDiscoveryController,
  type PublicDiscoveryState,
} from "@/features/catalog/public-course-discovery";

/**
 * M2-22 — the anonymous published-course discovery page (`/discover`).
 *
 * This page is PUBLIC: it is mounted without `AuthGuard`, it requires no
 * session, and it consults no principal. Everything it renders comes from the
 * fixed ten-field projection the server returns for published, active courses
 * of ACTIVE academies:
 *
 *   { course_id, name, subject, description, grade, tenant_id, business_name,
 *     display_name_ar, display_name_en, accent_color }
 *
 * There is deliberately nothing else on this page — no price, no instructor, no
 * lesson or material, no contact detail, no enrollment, no "subscribe" and no
 * payment. Discovering a course is not access to it: opening a course, joining
 * an academy and paying for anything all happen somewhere else, under their own
 * authority.
 *
 * The page owns no request logic. Every read, the bounded "next page", the
 * debounced search and the exact detail read live in
 * `src/features/catalog/public-course-discovery.ts`, which is exercised
 * hermetically by `src/tests/m2-public-course-discovery.test.ts`.
 */

/** The academy label the card shows: the Arabic display name, then the English
 *  one, then the registered business name. All three come from the server. */
const academyLabel = (course: PublicCourse): string =>
  course.display_name_ar || course.display_name_en || course.business_name;

/** The canonical accent, or `undefined` so the card keeps its own palette. */
const accentStyle = (course: PublicCourse): React.CSSProperties | undefined =>
  course.accent_color ? { borderTopColor: course.accent_color, borderTopWidth: 3 } : undefined;

const PublicCourseDiscovery = () => {
  const [controller, setController] = useState<PublicCourseDiscoveryController | null>(null);
  const [snapshot, setSnapshot] = useState<PublicDiscoveryState | null>(null);

  useEffect(() => {
    // One controller per mount: it owns the request lifecycle and the debounce
    // timer, and disposal retires everything in flight and cancels the timer.
    const instance = createProductionPublicCourseDiscoveryController();
    const unsubscribe = instance.subscribe(setSnapshot);
    void instance.load();
    setController(instance);
    return () => {
      unsubscribe();
      instance.dispose();
      setController(null);
    };
  }, []);

  const state = snapshot;
  const courses = state?.courses ?? [];
  const detail = state?.detail ?? null;
  const searchInput = state?.searchInput ?? "";

  const detailOpen = detail !== null && detail.courseId !== null;
  const hasMore = (state?.nextCursor ?? null) !== null;
  const loadingMore = state?.loadingMore === true;

  /** Only the server's own cursor can ask for more; the button is disabled
   *  while a read is in flight so a double click never stacks requests. */
  const loadMore = () => {
    void controller?.loadMore();
  };

  const closeDetail = () => {
    controller?.closeDetail();
  };

  const searchLabel = useMemo(
    () => `ابحث في الكورسات المنشورة (حتى ${PUBLIC_COURSE_SEARCH_MAX} حرفًا)`,
    [],
  );

  return (
    <div
      className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950"
      dir="rtl"
    >
      <header className="border-b bg-background/80 backdrop-blur">
        <div className="container mx-auto flex items-center gap-3 px-4 py-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <GraduationCap className="h-6 w-6 text-primary" />
          </div>
          <div>
            <p className="text-lg font-bold text-foreground">استكشف الكورسات</p>
            <p className="text-sm text-muted-foreground">
              كورسات منشورة من الأكاديميات النشطة
            </p>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <div className="mb-6 space-y-2">
          <label htmlFor="public-course-search" className="sr-only">
            {searchLabel}
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="public-course-search"
              value={searchInput}
              onChange={(event) => controller?.setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void controller?.applySearch();
                }
              }}
              placeholder="ابحث باسم الكورس أو المادة"
              aria-describedby="public-course-search-hint"
              maxLength={PUBLIC_COURSE_SEARCH_MAX * 2}
              className="pr-9"
            />
          </div>
          <p id="public-course-search-hint" className="text-xs text-muted-foreground">
            يُبحث في اسم الكورس والمادة فقط. الحد الأقصى {PUBLIC_COURSE_SEARCH_MAX} حرفًا.
          </p>
        </div>

        {state?.error && (
          <div
            role="alert"
            className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          >
            <span>{state.error}</span>
            <Button variant="outline" size="sm" onClick={() => void controller?.refresh()}>
              إعادة المحاولة
            </Button>
          </div>
        )}

        {state?.phase === "loading" && (
          <div className="py-12 text-center" role="status" aria-live="polite">
            <p className="text-muted-foreground">جاري تحميل الكورسات المنشورة...</p>
          </div>
        )}

        {state?.phase === "idle" && (
          <div className="py-12 text-center">
            <p className="text-muted-foreground">ابدأ البحث أو حدّث الصفحة لعرض الكورسات.</p>
          </div>
        )}

        {state?.phase === "empty" && (
          <div className="py-12 text-center" role="status" aria-live="polite">
            <BookOpen className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
            <p className="text-muted-foreground">
              {state.appliedSearch
                ? `لا توجد كورسات منشورة تطابق «${state.appliedSearch}».`
                : "لا توجد كورسات منشورة حاليًا."}
            </p>
          </div>
        )}

        {(state?.phase === "ready" || courses.length > 0) && courses.length > 0 && (
          <>
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
              {courses.map((course) => (
                <Card
                  key={course.course_id}
                  className="shadow-soft transition-all hover:shadow-medium"
                  style={accentStyle(course)}
                >
                  <CardHeader>
                    <CardTitle className="flex items-start justify-between gap-2">
                      <div>
                        <p>{course.name}</p>
                        <p className="text-sm font-normal text-muted-foreground">
                          {course.subject ?? "مادة غير محددة"}
                        </p>
                      </div>
                      <BookOpen className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <p className="text-sm text-muted-foreground">
                      <span className="font-medium text-foreground">الأكاديمية: </span>
                      {academyLabel(course)}
                    </p>
                    {course.grade && (
                      <p className="text-sm text-muted-foreground">
                        <span className="font-medium text-foreground">الصف: </span>
                        {course.grade}
                      </p>
                    )}
                    {course.description && (
                      <p className="line-clamp-4 text-sm text-muted-foreground">
                        {course.description}
                      </p>
                    )}
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() => void controller?.openDetail(course.course_id)}
                    >
                      عرض التفاصيل
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>

            <div className="mt-8 flex justify-center">
              {hasMore ? (
                <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? "جاري التحميل..." : "عرض المزيد"}
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">تم عرض كل الكورسات المنشورة.</p>
              )}
            </div>
          </>
        )}

        <Dialog
          open={detailOpen}
          onOpenChange={(open) => {
            if (!open) closeDetail();
          }}
        >
          <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto">
            <DialogHeader>
              <DialogTitle>تفاصيل الكورس</DialogTitle>
              <DialogDescription>
                بيانات الكورس كما نشرتها الأكاديمية. لا يتضمن هذا العرض تسجيلًا ولا وصولًا
                إلى الدروس أو الملفات.
              </DialogDescription>
            </DialogHeader>

            {detail?.status === "loading" && (
              <p className="py-6 text-center text-muted-foreground" role="status" aria-live="polite">
                جاري تحميل التفاصيل...
              </p>
            )}

            {detail?.status === "unavailable" && (
              <p className="py-6 text-center text-muted-foreground" role="status" aria-live="polite">
                هذا الكورس لم يعد متاحًا.
              </p>
            )}

            {detail?.status === "error" && (
              <p className="py-6 text-center text-destructive" role="alert">
                {detail.error ?? "تعذّر تحميل تفاصيل الكورس."}
              </p>
            )}

            {detail?.status === "ready" && detail.course && (
              <div className="space-y-3">
                <p className="text-lg font-semibold text-foreground">{detail.course.name}</p>
                <p className="text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">الأكاديمية: </span>
                  {academyLabel(detail.course)}
                </p>
                {detail.course.subject && (
                  <p className="text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">المادة: </span>
                    {detail.course.subject}
                  </p>
                )}
                {detail.course.grade && (
                  <p className="text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">الصف: </span>
                    {detail.course.grade}
                  </p>
                )}
                {detail.course.description && (
                  <p className="whitespace-pre-line text-sm text-muted-foreground">
                    {detail.course.description}
                  </p>
                )}
                <Button variant="outline" className="w-full" onClick={closeDetail}>
                  إغلاق
                </Button>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </main>
    </div>
  );
};

export default PublicCourseDiscovery;
