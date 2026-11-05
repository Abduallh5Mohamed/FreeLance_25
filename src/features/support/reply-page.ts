import type { SupportReply } from '../../lib/api-http';

export interface SupportReplyPage { replies: SupportReply[]; next_cursor: string | null }
export function parseSupportReplyPage(value: unknown): SupportReplyPage {
  const invalid = () => new Error('تعذّر التحقق من رسائل الدعم. حاول تحديث التذكرة.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const page = value as Record<string, unknown>;
  if (Object.keys(page).length !== 2 || !Array.isArray(page.replies) || page.replies.length > 100
    || !(page.next_cursor === null || typeof page.next_cursor === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(page.next_cursor))) throw invalid();
  const ids = new Set<string>();
  const replies = page.replies.map((raw): SupportReply => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid();
    const row = raw as Record<string, unknown>;
    const keys = ['id','body','created_at','sender_id','sender_name','sender_role'];
    if (Object.keys(row).length !== keys.length || !keys.every(key => typeof row[key] === 'string')
      || !/^[a-zA-Z0-9-]{1,64}$/.test(row.id as string) || ids.has(row.id as string)
      || (row.body as string).length > 10000 || !Number.isFinite(Date.parse(row.created_at as string))) throw invalid();
    ids.add(row.id as string);
    return { id: row.id as string, body: row.body as string, created_at: row.created_at as string,
      sender_id: row.sender_id as string, sender_name: row.sender_name as string, sender_role: row.sender_role as string };
  });
  if (page.next_cursor !== null && (replies.length !== 100 || page.next_cursor !== replies[0].id)) throw invalid();
  return { replies, next_cursor: page.next_cursor as string | null };
}
