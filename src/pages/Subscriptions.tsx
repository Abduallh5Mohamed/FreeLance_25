import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { CreditCard, Plus, Edit2, Trash2, Loader2 } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/components/ui/use-toast";
import { getSubscriptions, createSubscription, updateSubscription, deleteSubscription, type Subscription } from "@/lib/api";

export interface SubscriptionsApi {
  getSubscriptions: () => Promise<Subscription[]>;
  createSubscription: (subscription: Partial<Subscription>) => Promise<Subscription>;
  updateSubscription: (id: string, subscription: Partial<Subscription>) => Promise<Subscription>;
  deleteSubscription: (id: string) => Promise<void>;
}

export interface SubscriptionsFormData {
  name: string;
  duration_months: string;
  price: string;
  description: string;
}

/**
 * Map an authoritative subscription row into the edit form. A legitimate `0`
 * price (or duration) is preserved as "0"; only a genuinely absent/non-finite
 * value becomes empty. The previous `String(price || '')` turned a real zero
 * price into an empty field, silently erasing it on edit.
 */
export function toSubscriptionFormData(subscription: Subscription): SubscriptionsFormData {
  return {
    name: subscription.name ?? '',
    duration_months: Number.isFinite(subscription.duration_months) ? String(subscription.duration_months) : '',
    price: Number.isFinite(subscription.price) ? String(subscription.price) : '',
    description: subscription.description ?? '',
  };
}

export interface SubscriptionsControllerHooks {
  onRows: (rows: Subscription[]) => void;
  onBusy: (busy: boolean) => void;
  onError: (message: string | null) => void;
  onNotice: (message: string) => void;
}

export const EMPTY_SUBSCRIPTION_FORM: SubscriptionsFormData = {
  name: "",
  duration_months: "",
  price: "",
  description: "",
};

export interface SubscriptionDialogState {
  open: boolean;
  /** The plan being edited, or null when the dialog is creating a new plan. */
  editing: Subscription | null;
  form: SubscriptionsFormData;
}

export const emptySubscriptionForm = (): SubscriptionsFormData => ({ ...EMPTY_SUBSCRIPTION_FORM });

export const initialSubscriptionDialogState = (): SubscriptionDialogState => ({
  open: false,
  editing: null,
  form: emptySubscriptionForm(),
});

/**
 * The explicit "Add subscription" action. It ALWAYS starts a fresh create: the
 * edit target is cleared, so a previous edit cannot leak into the new dialog.
 * Previously handleEdit set editingSubscription and nothing ever cleared it
 * (not a successful save, not the Add trigger), so Edit -> close/save -> Add ->
 * submit routed to update(oldId) and overwrote an existing plan while the user
 * intended to create a new one.
 */
export const beginCreateSubscription = (): SubscriptionDialogState => ({
  open: true,
  editing: null,
  form: emptySubscriptionForm(),
});

export const beginEditSubscription = (subscription: Subscription): SubscriptionDialogState => ({
  open: true,
  editing: subscription,
  form: toSubscriptionFormData(subscription),
});

/** Successful save: close the dialog AND clear the edit target. */
export const completeSubscriptionSave = (): SubscriptionDialogState => ({
  open: false,
  editing: null,
  form: emptySubscriptionForm(),
});

/**
 * Closing without saving keeps the edit target and the entered values, so a
 * failed edit save can be retried without re-entering the plan.
 */
export const closeSubscriptionDialog = (state: SubscriptionDialogState): SubscriptionDialogState => ({
  ...state,
  open: false,
});

export type SubscriptionSubmitTarget = { kind: 'create' } | { kind: 'update'; id: string };

/** The dialog's current intent decides whether submit creates or updates. */
export const resolveSubscriptionSubmitTarget = (
  editing: Subscription | null,
): SubscriptionSubmitTarget => (editing ? { kind: 'update', id: editing.id } : { kind: 'create' });

export interface SubscriptionsController {
  load: () => Promise<void>;
  create: (input: Partial<Subscription>) => Promise<boolean>;
  update: (id: string, patch: Partial<Subscription>) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  toggle: (id: string, currentStatus: boolean) => Promise<boolean>;
  isMutating: () => boolean;
}

/**
 * Production create/update/delete + load orchestration for the subscriptions
 * page. The API is injected so the exact production path can be exercised with
 * fakes. Two guards protect it:
 *  - a synchronous single-flight latch (`mutationBusy`) that is set before the
 *    first await, so a second create/update/delete fired in the same tick is
 *    rejected regardless of React render timing — a disabled button alone is
 *    not enough because it only applies after a render;
 *  - a monotonic load generation counter, so a late/stale load response can
 *    never overwrite the rows produced by a newer load.
 * A failed mutation surfaces the error and does NOT reload, so the user's
 * entered values are retained.
 */
export function createSubscriptionsController(
  api: SubscriptionsApi,
  hooks: SubscriptionsControllerHooks,
): SubscriptionsController {
  let loadGeneration = 0;
  let mutationBusy = false;

  const load = async (): Promise<void> => {
    const generation = ++loadGeneration;
    hooks.onError(null);
    try {
      const rows = await api.getSubscriptions();
      if (generation !== loadGeneration) return; // superseded by a newer load
      if (!Array.isArray(rows)) {
        // A malformed non-array body is invalid server data, not an empty list;
        // conflating the two hid the failure behind the "no subscriptions" state.
        hooks.onError("استجابة غير صالحة من الخادم");
        return;
      }
      hooks.onRows(rows);
    } catch (cause) {
      if (generation !== loadGeneration) return; // a stale failure must not clobber newer state
      hooks.onError(cause instanceof Error ? cause.message : "فشل في جلب الاشتراكات");
    }
  };

  const mutate = async (action: () => Promise<unknown>, notice: string): Promise<boolean> => {
    if (mutationBusy) return false; // synchronous single-flight: duplicate rejected pre-render
    mutationBusy = true;
    hooks.onBusy(true);
    hooks.onError(null);
    try {
      await action();
      hooks.onNotice(notice);
      await load();
      return true;
    } catch (cause) {
      hooks.onError(cause instanceof Error ? cause.message : "تعذر إتمام العملية");
      return false;
    } finally {
      mutationBusy = false;
      hooks.onBusy(false);
    }
  };

  return {
    load,
    create: (input) => mutate(() => api.createSubscription(input), "تم إنشاء الاشتراك"),
    update: (id, patch) => mutate(() => api.updateSubscription(id, patch), "تم تحديث الاشتراك"),
    remove: (id) => mutate(() => api.deleteSubscription(id), "تم حذف الاشتراك"),
    toggle: (id, currentStatus) => mutate(() => api.updateSubscription(id, { is_active: !currentStatus }), `تم ${!currentStatus ? "تفعيل" : "إلغاء"} الاشتراك`),
    isMutating: () => mutationBusy,
  };
}

const Subscriptions = () => {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [dialog, setDialog] = useState<SubscriptionDialogState>(initialSubscriptionDialogState);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { open: isOpen, editing: editingSubscription, form: formData } = dialog;

  const { toast } = useToast();

  const controllerRef = useRef<SubscriptionsController | null>(null);
  let controller = controllerRef.current;
  if (!controller) {
    controller = createSubscriptionsController(
      { getSubscriptions, createSubscription, updateSubscription, deleteSubscription },
      {
        onRows: setSubscriptions,
        onBusy: setLoading,
        onError: (message) => {
          setError(message);
          if (message) toast({ title: "خطأ", description: message, variant: "destructive" });
        },
        onNotice: (message) => toast({ title: "تم", description: message }),
      },
    );
    controllerRef.current = controller;
  }

  useEffect(() => { void controller.load(); }, [controller]);

  const updateForm = (patch: Partial<SubscriptionsFormData>) => {
    setDialog(prev => ({ ...prev, form: { ...prev.form, ...patch } }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload: Partial<Subscription> = { name: formData.name, duration_months: parseInt(formData.duration_months), price: parseFloat(formData.price), description: formData.description };
    const target = resolveSubscriptionSubmitTarget(editingSubscription);
    const saved = target.kind === 'update'
      ? await controller.update(target.id, payload)
      : await controller.create(payload);
    if (!saved) return; // keep the dialog, the edit target and the entered values when the save failed
    setDialog(completeSubscriptionSave());
  };

  // Explicit "Add" always starts a fresh create — never a stale edit target.
  const handleAdd = () => setDialog(beginCreateSubscription());

  const handleEdit = (subscription: Subscription) => setDialog(beginEditSubscription(subscription));

  const handleOpenChange = (open: boolean) => {
    setDialog(prev => (open ? { ...prev, open } : closeSubscriptionDialog(prev)));
  };

  const handleDelete = (id: string) => { void controller.remove(id); };

  const toggleActive = (id: string, currentStatus: boolean) => { void controller.toggle(id, currentStatus); };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950" dir="rtl">
      <Header />
      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
              <CreditCard className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">إدارة الاشتراكات</h1>
              <p className="text-muted-foreground">إضافة وإدارة خطط الاشتراك للطلاب</p>
            </div>
          </div>

          <Dialog open={isOpen} onOpenChange={handleOpenChange}>
            <DialogTrigger asChild>
              <Button className="shadow-medium" onClick={handleAdd}>
                <Plus className="w-4 h-4 ml-2" />
                إضافة اشتراك جديد
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>{editingSubscription ? "تعديل الاشتراك" : "إضافة اشتراك جديد"}</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">اسم الاشتراك</Label>
                  <Input id="name" value={formData.name} onChange={(e) => updateForm({ name: e.target.value })} placeholder="مثال: اشتراك شهري" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="duration_months">المدة (بالأشهر)</Label>
                  <Input id="duration_months" type="number" min="1" value={formData.duration_months} onChange={(e) => updateForm({ duration_months: e.target.value })} placeholder="3" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="price">السعر (جنيه)</Label>
                  <Input id="price" type="number" min="0" step="0.01" value={formData.price} onChange={(e) => updateForm({ price: e.target.value })} placeholder="500" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">الوصف</Label>
                  <Textarea id="description" value={formData.description} onChange={(e) => updateForm({ description: e.target.value })} placeholder="وصف مختصر للاشتراك..." rows={3} />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>{loading ? "جاري المعالجة..." : (editingSubscription ? "تحديث الاشتراك" : "إضافة الاشتراك")}</Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        <Card className="shadow-soft">
          <CardHeader>
            <CardTitle>قائمة الاشتراكات</CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            {error && (
              <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>
            )}
            {loading && subscriptions.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Loader2 className="w-8 h-8 mx-auto mb-4 animate-spin" />
                <p className="text-lg font-medium">جاري تحميل الاشتراكات...</p>
              </div>
            ) : subscriptions.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <CreditCard className="w-16 h-16 mx-auto mb-4 opacity-20" />
                <p className="text-lg font-medium">لا توجد اشتراكات مسجلة</p>
              </div>
            ) : (
              <div className="space-y-4">
                {subscriptions.map((subscription) => (
                  <div key={subscription.id} className="border border-cyan-200 dark:border-cyan-800 rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-shadow bg-white dark:bg-slate-900">
                    <div className="bg-gradient-to-r from-cyan-500 to-teal-500 px-4 py-2 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 bg-white/10 rounded flex items-center justify-center"><CreditCard className="w-5 h-5 text-white" /></div>
                        <div>
                          <h3 className="font-bold text-white text-lg">{subscription.name}</h3>
                          <div className="flex items-center gap-2 text-xs text-cyan-50"><span>{subscription.duration_months} شهر</span><span>{subscription.price} ج.م</span></div>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button variant="ghost" size="sm" onClick={() => handleEdit(subscription)} className="h-8 w-8 p-0 text-white hover:bg-white/20"><Edit2 className="w-4 h-4" /></Button>
                        <Button variant="ghost" size="sm" onClick={() => handleDelete(subscription.id)} className="h-8 w-8 p-0 text-white hover:bg-red-500/30"><Trash2 className="w-4 h-4" /></Button>
                      </div>
                    </div>
                    <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      <div>
                        <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">📝 الوصف</div>
                        <div className="text-sm text-muted-foreground">{subscription.description || 'لا يوجد وصف'}</div>
                      </div>
                      <div>
                        <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">⏳ المدة</div>
                        <div className="text-sm font-medium">{subscription.duration_months} شهر</div>
                      </div>
                      <div>
                        <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">💰 السعر</div>
                        <div className="text-sm font-bold">{subscription.price} ج.م</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default Subscriptions;