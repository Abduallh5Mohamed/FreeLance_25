import { randomUUID } from 'crypto';
import { Router, Response } from 'express';
import { ResultSetHeader, RowDataPacket } from 'mysql2';
import { getPool, query, queryOne } from '../db';
import { authenticateToken, AuthRequest, requireRoles } from '../middleware/auth';
import { createNotification } from '../utils/notifications';

const router = Router();
router.use(authenticateToken);

const ACTIVE = new Set(['open', 'awaiting_requester']);
const text = (value: unknown, max: number) => String(value ?? '').trim().slice(0, max);
const phone = (value: unknown) => String(value ?? '').replace(/[^0-9+]/g, '');

async function expireOverdue() {
  const connection = await getPool().getConnection();
  let expired: Array<{ id: number; requester_id: string; owner_id: string }> = [];
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT id,requester_id,owner_id FROM instructor_video_requests
      WHERE status IN ('open','awaiting_requester') AND expires_at<=UTC_TIMESTAMP() FOR UPDATE`);
    expired = rows as Array<RowDataPacket & { id: number; requester_id: string; owner_id: string }>;
    if (expired.length) await connection.execute(`UPDATE instructor_video_requests SET status='expired',updated_at=UTC_TIMESTAMP()
      WHERE status IN ('open','awaiting_requester') AND expires_at<=UTC_TIMESTAMP()`);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  if (!expired.length) return;
  for (const item of expired) for (const userId of [item.requester_id, item.owner_id]) {
    void createNotification({ user_id: userId, user_type: 'instructor', type: 'general',
      title: 'انتهت مهلة طلب الفيديو', message: `انتهت مهلة الطلب رقم ${item.id}.`, link: '/instructor-video-requests' });
  }
}

const expiryTimer = setInterval(() => void expireOverdue().catch(console.error), 60_000);
expiryTimer.unref();

async function ownRequest(id: string, userId: string) {
  await expireOverdue();
  return queryOne<any>(`SELECT r.*,requester.name requester_name,owner.name owner_name
    FROM instructor_video_requests r JOIN users requester ON requester.id=r.requester_id
    JOIN users owner ON owner.id=r.owner_id
    WHERE r.id=? AND (r.requester_id=? OR r.owner_id=?)`, [id, userId, userId]);
}

router.get('/search-instructors', requireRoles('instructor'), async (req: AuthRequest, res: Response) => {
  const term = text(req.query.q, 100);
  if (term.length < 2) return res.json([]);
  const normalized = phone(term);
  const rows = await query(`SELECT id,name,phone FROM users
    WHERE role='instructor' AND is_active=1 AND id<>?
      AND (name LIKE ? OR (?<>'' AND REPLACE(REPLACE(phone,' ',''),'-','') LIKE ?))
    ORDER BY CASE WHEN REPLACE(REPLACE(phone,' ',''),'-','')=? THEN 0 ELSE 1 END,name LIMIT 20`,
    [req.user!.id, `%${term}%`, normalized, `%${normalized}%`, normalized]);
  return res.json(rows);
});

router.get('/', async (req: AuthRequest, res: Response) => {
  await expireOverdue();
  if (!['admin', 'staff'].includes(req.user!.role)) return res.status(403).json({ error: 'Forbidden' });
  const status = text(req.query.status, 40);
  return res.json(await query(`SELECT r.*,requester.name requester_name,owner.name owner_name
    FROM instructor_video_requests r JOIN users requester ON requester.id=r.requester_id
    JOIN users owner ON owner.id=r.owner_id ${status ? 'WHERE r.status=?' : ''}
    ORDER BY r.created_at DESC LIMIT 500`, status ? [status] : []));
});

router.get('/mine', requireRoles('instructor'), async (req: AuthRequest, res: Response) => {
  await expireOverdue();
  const column = req.query.direction === 'received' ? 'r.owner_id' : 'r.requester_id';
  return res.json(await query(`SELECT r.*,requester.name requester_name,requester.phone requester_phone,
      owner.name owner_name,owner.phone owner_phone,o.id active_offer_id,o.lecture_id active_lecture_id,
      o.video_id active_video_id,o.title_snapshot active_offer_title,o.price_snapshot active_offer_price,
      o.status active_offer_status,o.proposed_at active_offer_proposed_at
    FROM instructor_video_requests r JOIN users requester ON requester.id=r.requester_id
    JOIN users owner ON owner.id=r.owner_id
    LEFT JOIN instructor_video_offers o ON o.request_id=r.id AND o.status='proposed'
    WHERE ${column}=? ORDER BY r.created_at DESC`, [req.user!.id]));
});

router.get('/shareable-lectures', requireRoles('instructor'), async (req: AuthRequest, res: Response) => {
  return res.json(await query(`SELECT l.id,l.title,l.description,l.price,l.duration_minutes,l.grade_id,
      g.name grade_name,v.id video_id,v.preview_duration_seconds,v.delivery_provider
    FROM lectures l JOIN videos v ON l.video_url=CONCAT('video://',v.id)
    LEFT JOIN grades g ON g.id=l.grade_id WHERE l.instructor_id=? AND l.archived_at IS NULL
      AND l.price>0 AND v.status='ready' AND v.preview_status='ready'
      AND v.preview_key IS NOT NULL AND v.is_encrypted=1
    ORDER BY l.created_at DESC`, [req.user!.id]));
});

router.get('/library/shared', requireRoles('instructor'), async (req: AuthRequest, res: Response) => {
  const rows = await query(`SELECT sl.id shared_lecture_id,sl.lecture_id,sl.request_id,sl.obtained_at,sl.is_published,
      l.title,l.description,l.duration_minutes,l.video_url,owner.name owner_name,p.gross_amount,p.commission_amount,
      GROUP_CONCAT(DISTINCT pub.group_id) group_ids,GROUP_CONCAT(DISTINCT grp.name) group_names,
      MAX(pub.grade_id) grade_id,MAX(gr.name) grade_name
    FROM instructor_shared_lectures sl JOIN lectures l ON l.id=sl.lecture_id
    JOIN users owner ON owner.id=l.instructor_id LEFT JOIN video_purchase_transactions p ON p.id=sl.purchase_id
    LEFT JOIN instructor_shared_lecture_publications pub ON pub.shared_lecture_id=sl.id
    LEFT JOIN \`groups\` grp ON grp.id=pub.group_id LEFT JOIN grades gr ON gr.id=pub.grade_id
    WHERE sl.instructor_id=? GROUP BY sl.id,l.id,owner.name,p.id ORDER BY sl.obtained_at DESC`, [req.user!.id]);
  return res.json(rows.map((row: any) => ({ ...row,
    group_ids: row.group_ids ? String(row.group_ids).split(',') : [],
    group_names: row.group_names ? String(row.group_names).split(',') : [] })));
});

router.post('/', requireRoles('instructor'), async (req: AuthRequest, res: Response) => {
  const ownerId = text(req.body.owner_id, 36);
  const title = text(req.body.requested_title, 255);
  const grade = text(req.body.requested_grade, 255);
  const group = text(req.body.requested_group, 255);
  const message = text(req.body.message, 2000);
  if (!ownerId || !title || !grade || !group) return res.status(400).json({ error: 'المدرس والدرس والصف والمجموعة حقول مطلوبة' });
  if (ownerId === req.user!.id) return res.status(400).json({ error: 'لا يمكنك إرسال طلب لنفسك' });
  const owner = await queryOne<any>("SELECT id FROM users WHERE id=? AND role='instructor' AND is_active=1", [ownerId]);
  if (!owner) return res.status(404).json({ error: 'المدرس غير موجود أو غير نشط' });
  const [result] = await getPool().execute<ResultSetHeader>(`INSERT INTO instructor_video_requests
    (requester_id,owner_id,requested_title,requested_grade,requested_group,message,status,expires_at)
    VALUES (?,?,?,?,?,?,'open',DATE_ADD(UTC_TIMESTAMP(),INTERVAL 48 HOUR))`,
    [req.user!.id, ownerId, title, grade, group, message || null]);
  void createNotification({ user_id: ownerId, user_type: 'instructor', type: 'general', title: 'طلب فيديو جديد', message: title, link: '/instructor-video-requests' });
  return res.status(201).json({ id: result.insertId, expires_in_hours: 48 });
});

router.get('/:id/offers', requireRoles('instructor'), async (req: AuthRequest, res: Response) => {
  const requestRow = await ownRequest(req.params.id, req.user!.id);
  if (!requestRow) return res.status(404).json({ error: 'الطلب غير موجود' });
  return res.json(await query(`SELECT o.*,l.description,l.duration_minutes FROM instructor_video_offers o
    JOIN lectures l ON l.id=o.lecture_id WHERE o.request_id=? ORDER BY o.proposed_at DESC`, [req.params.id]));
});

router.post('/:id/offers', requireRoles('instructor'), async (req: AuthRequest, res: Response) => {
  const requestRow = await ownRequest(req.params.id, req.user!.id);
  if (!requestRow) return res.status(404).json({ error: 'الطلب غير موجود' });
  if (requestRow.owner_id !== req.user!.id) return res.status(403).json({ error: 'صاحب الفيديو فقط يمكنه الترشيح' });
  if (requestRow.status !== 'open') return res.status(409).json({ error: 'الطلب غير متاح لعرض جديد' });
  const lecture = await queryOne<any>(`SELECT l.id,l.title,l.price,v.id video_id,v.preview_status,v.preview_key,
      v.delivery_provider,v.drm_preview_asset_id,v.status video_status
    FROM lectures l JOIN videos v ON l.video_url=CONCAT('video://',v.id)
    WHERE l.id=? AND l.instructor_id=? AND l.archived_at IS NULL`, [req.body.lecture_id, req.user!.id]);
  if (!lecture) return res.status(404).json({ error: 'الفيديو غير موجود في مكتبتك' });
  const alreadyOwned = await queryOne('SELECT id FROM instructor_shared_lectures WHERE instructor_id=? AND lecture_id=?', [requestRow.requester_id, lecture.id]);
  if (alreadyOwned) return res.status(409).json({ error: 'صاحب الطلب لديه صلاحية هذا الفيديو بالفعل' });
  const hasPreview = lecture.preview_key && lecture.delivery_provider !== 'vdocipher';
  if (Number(lecture.price) <= 0 || lecture.video_status !== 'ready' || lecture.preview_status !== 'ready' || !hasPreview) {
    return res.status(409).json({ error: 'الفيديو يجب أن يكون جاهزًا وله سعر ومعاينة' });
  }
  const offerId = randomUUID();
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute("UPDATE instructor_video_offers SET status='superseded',decided_at=UTC_TIMESTAMP() WHERE request_id=? AND status='proposed'", [requestRow.id]);
    await connection.execute(`INSERT INTO instructor_video_offers(id,request_id,lecture_id,video_id,title_snapshot,price_snapshot)
      VALUES (?,?,?,?,?,?)`, [offerId, requestRow.id, lecture.id, lecture.video_id, lecture.title, lecture.price]);
    await connection.execute("UPDATE instructor_video_requests SET status='awaiting_requester',expires_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 48 HOUR),updated_at=UTC_TIMESTAMP() WHERE id=?", [requestRow.id]);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  void createNotification({ user_id: requestRow.requester_id, user_type: 'instructor', type: 'general', title: 'تم ترشيح فيديو لطلبك', message: `${lecture.title} — ${Number(lecture.price).toFixed(2)} ج.م`, link: '/instructor-video-requests' });
  return res.status(201).json({ id: offerId, expires_in_hours: 48 });
});

router.get('/offers/:offerId/preview', requireRoles('instructor'), async (req: AuthRequest, res: Response) => {
  await expireOverdue();
  const offer = await queryOne<any>(`SELECT o.id,o.title_snapshot,o.price_snapshot,v.preview_key,v.preview_duration_seconds,
      v.delivery_provider,v.drm_preview_asset_id,
      r.requester_id,r.owner_id,r.status request_status FROM instructor_video_offers o
    JOIN instructor_video_requests r ON r.id=o.request_id JOIN videos v ON v.id=o.video_id
    WHERE o.id=? AND (r.requester_id=? OR r.owner_id=?)`, [req.params.offerId, req.user!.id, req.user!.id]);
  if (!offer) return res.status(404).json({ error: 'العرض غير موجود' });
  if (!ACTIVE.has(offer.request_status) && offer.request_status !== 'completed') return res.status(409).json({ error: 'الطلب مغلق' });
  if (!offer.preview_key) return res.status(409).json({ error: 'المعاينة غير جاهزة' });
  return res.json({ offer_id: offer.id, title: offer.title_snapshot, price: Number(offer.price_snapshot),
    duration_seconds: offer.preview_duration_seconds,
    provider: 'encrypted-hls', video_session_required: true });
});

router.post('/offers/:offerId/reject', requireRoles('instructor'), async (req: AuthRequest, res: Response) => {
  await expireOverdue();
  const reason = text(req.body.reason, 1000);
  if (reason.length < 3) return res.status(400).json({ error: 'سبب الرفض مطلوب' });
  const offer = await queryOne<any>(`SELECT o.*,r.requester_id,r.owner_id,r.status request_status
    FROM instructor_video_offers o JOIN instructor_video_requests r ON r.id=o.request_id WHERE o.id=?`, [req.params.offerId]);
  if (!offer) return res.status(404).json({ error: 'العرض غير موجود' });
  if (offer.requester_id !== req.user!.id) return res.status(403).json({ error: 'صاحب الطلب فقط يمكنه رفض العرض' });
  if (offer.status !== 'proposed' || offer.request_status !== 'awaiting_requester') return res.status(409).json({ error: 'العرض لم يعد متاحًا' });
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute("UPDATE instructor_video_offers SET status='rejected',rejection_reason=?,decided_at=UTC_TIMESTAMP() WHERE id=?", [reason, offer.id]);
    await connection.execute("UPDATE instructor_video_requests SET status='open',updated_at=UTC_TIMESTAMP() WHERE id=?", [offer.request_id]);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  void createNotification({ user_id: offer.owner_id, user_type: 'instructor', type: 'general', title: 'تم رفض ترشيح الفيديو', message: reason, link: '/instructor-video-requests' });
  return res.json({ status: 'open' });
});

router.post('/offers/:offerId/accept', requireRoles('instructor'), async (req: AuthRequest, res: Response) => {
  const connection = await getPool().getConnection();
  const purchaseId = randomUUID();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT o.*,r.requester_id,r.owner_id,
      r.status request_status,r.expires_at,(r.expires_at<=UTC_TIMESTAMP()) is_expired FROM instructor_video_offers o
      JOIN instructor_video_requests r ON r.id=o.request_id WHERE o.id=? FOR UPDATE`, [req.params.offerId]);
    const offer = rows[0] as any;
    if (!offer) { await connection.rollback(); return res.status(404).json({ error: 'العرض غير موجود' }); }
    if (offer.requester_id !== req.user!.id) { await connection.rollback(); return res.status(403).json({ error: 'صاحب الطلب فقط يمكنه القبول' }); }
    if (offer.status !== 'proposed' || offer.request_status !== 'awaiting_requester') { await connection.rollback(); return res.status(409).json({ error: 'العرض لم يعد متاحًا' }); }
    if (Boolean(offer.is_expired)) {
      await connection.execute("UPDATE instructor_video_requests SET status='expired' WHERE id=?", [offer.request_id]);
      await connection.commit(); return res.status(409).json({ error: 'انتهت مهلة الطلب' });
    }
    await connection.execute('INSERT IGNORE INTO instructor_wallets(instructor_id,balance) VALUES (?,0),(?,0)', [offer.requester_id, offer.owner_id]);
    const [walletRows] = await connection.execute<RowDataPacket[]>('SELECT instructor_id,balance FROM instructor_wallets WHERE instructor_id IN (?,?) ORDER BY instructor_id FOR UPDATE', [offer.requester_id, offer.owner_id]);
    const balances = new Map(walletRows.map(row => [String(row.instructor_id), Number(row.balance)]));
    const gross = Number(offer.price_snapshot), buyerBalance = balances.get(String(offer.requester_id)) ?? 0;
    if (buyerBalance < gross) {
      await connection.execute("UPDATE instructor_video_requests SET status='failed_insufficient_balance',updated_at=UTC_TIMESTAMP() WHERE id=?", [offer.request_id]);
      await connection.execute("UPDATE instructor_video_offers SET status='superseded',decided_at=UTC_TIMESTAMP() WHERE id=?", [offer.id]);
      await connection.commit();
      void createNotification({ user_id: offer.requester_id, user_type: 'instructor', type: 'payment', title: 'الرصيد غير كافٍ', message: `تم إنهاء طلب ${offer.title_snapshot}.`, link: '/instructor-wallet' });
      return res.status(409).json({ error: 'رصيدك غير كافٍ وتم إنهاء الطلب', code: 'INSUFFICIENT_BALANCE' });
    }
    const [settings] = await connection.execute<RowDataPacket[]>("SELECT setting_value FROM platform_settings WHERE setting_key='video_commission_percent' FOR UPDATE");
    const commissionPercent = Math.min(100, Math.max(0, Number(settings[0]?.setting_value ?? 2)));
    const commission = Math.round(gross * commissionPercent) / 100;
    const sellerNet = Math.round((gross - commission) * 100) / 100;
    const buyerAfter = Math.round((buyerBalance - gross) * 100) / 100;
    const sellerAfter = Math.round(((balances.get(String(offer.owner_id)) ?? 0) + sellerNet) * 100) / 100;
    await connection.execute('UPDATE instructor_wallets SET balance=? WHERE instructor_id=?', [buyerAfter, offer.requester_id]);
    await connection.execute('UPDATE instructor_wallets SET balance=? WHERE instructor_id=?', [sellerAfter, offer.owner_id]);
    await connection.execute(`INSERT INTO video_purchase_transactions(id,request_id,offer_id,buyer_id,seller_id,lecture_id,gross_amount,commission_percent,commission_amount,seller_net_amount)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, [purchaseId, offer.request_id, offer.id, offer.requester_id, offer.owner_id, offer.lecture_id, gross, commissionPercent, commission, sellerNet]);
    await connection.execute(`INSERT INTO instructor_wallet_transactions(instructor_id,type,amount,balance_after,description,reference_id,transaction_group_id,category)
      VALUES (?,'debit',?,?,?,?,?,'video_purchase'),(?,'credit',?,?,?,?,?,'video_sale')`,
      [offer.requester_id, gross, buyerAfter, `شراء فيديو: ${offer.title_snapshot}`, offer.request_id, purchaseId,
       offer.owner_id, sellerNet, sellerAfter, `بيع فيديو: ${offer.title_snapshot}`, offer.request_id, purchaseId]);
    await connection.execute('INSERT INTO platform_video_revenue(id,purchase_id,amount) VALUES (?,?,?)', [randomUUID(), purchaseId, commission]);
    await connection.execute(`INSERT INTO instructor_shared_lectures(instructor_id,lecture_id,request_id,purchase_id,is_published)
      VALUES (?,?,?,?,0) ON DUPLICATE KEY UPDATE purchase_id=COALESCE(purchase_id,VALUES(purchase_id))`, [offer.requester_id, offer.lecture_id, offer.request_id, purchaseId]);
    await connection.execute("UPDATE instructor_video_offers SET status='accepted',decided_at=UTC_TIMESTAMP() WHERE id=?", [offer.id]);
    await connection.execute("UPDATE instructor_video_requests SET status='completed',completed_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP() WHERE id=?", [offer.request_id]);
    await connection.commit();
    void createNotification({ user_id: offer.owner_id, user_type: 'instructor', type: 'payment', title: 'تم بيع الفيديو', message: `تم بيع ${offer.title_snapshot} وإضافة صافي المبلغ.`, link: '/instructor-wallet' });
    return res.json({ status: 'completed', purchase_id: purchaseId, gross, commission, seller_net: sellerNet });
  } catch (error: any) {
    await connection.rollback();
    if (error?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'تم تنفيذ الشراء بالفعل' });
    console.error('Accept video offer failed:', error);
    return res.status(500).json({ error: 'تعذر إتمام عملية الشراء' });
  } finally { connection.release(); }
});

router.post('/:id/cancel', requireRoles('instructor'), async (req: AuthRequest, res: Response) => {
  const requestRow = await ownRequest(req.params.id, req.user!.id);
  if (!requestRow) return res.status(404).json({ error: 'الطلب غير موجود' });
  if (!ACTIVE.has(requestRow.status)) return res.status(409).json({ error: 'الطلب مغلق بالفعل' });
  const status = requestRow.requester_id === req.user!.id ? 'cancelled_by_requester' : 'cancelled_by_owner';
  const reason = text(req.body.reason, 1000);
  await query(`UPDATE instructor_video_requests SET status=?,cancelled_at=UTC_TIMESTAMP(),cancelled_by=?,
    cancellation_reason=?,updated_at=UTC_TIMESTAMP() WHERE id=? AND status IN ('open','awaiting_requester')`,
    [status, req.user!.id, reason || null, requestRow.id]);
  await query("UPDATE instructor_video_offers SET status='superseded',decided_at=UTC_TIMESTAMP() WHERE request_id=? AND status='proposed'", [requestRow.id]);
  const recipient = requestRow.requester_id === req.user!.id ? requestRow.owner_id : requestRow.requester_id;
  void createNotification({ user_id: recipient, user_type: 'instructor', type: 'general', title: 'تم إلغاء طلب الفيديو', message: reason || `تم إلغاء الطلب رقم ${requestRow.id}.`, link: '/instructor-video-requests' });
  return res.json({ status });
});

router.put('/library/shared/:sharedId/publications', requireRoles('instructor'), async (req: AuthRequest, res: Response) => {
  const gradeId = text(req.body.grade_id, 36);
  const groupIds: string[] = Array.isArray(req.body.group_ids) ? [...new Set<string>(req.body.group_ids.map((id: unknown) => text(id, 36)).filter(Boolean))] : [];
  if (!gradeId || !groupIds.length) return res.status(400).json({ error: 'اختر الصف ومجموعة واحدة على الأقل' });
  const shared = await queryOne<any>('SELECT id FROM instructor_shared_lectures WHERE id=? AND instructor_id=?', [req.params.sharedId, req.user!.id]);
  if (!shared) return res.status(404).json({ error: 'الفيديو المشترك غير موجود' });
  const placeholders = groupIds.map(() => '?').join(',');
  const owned = await query<any>(`SELECT id FROM \`groups\` WHERE id IN (${placeholders}) AND grade_id=? AND instructor_id=? AND is_active=1`, [...groupIds, gradeId, req.user!.id]);
  if (owned.length !== groupIds.length) return res.status(400).json({ error: 'المجموعات يجب أن تتبع لك وللصف المختار' });
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('DELETE FROM instructor_shared_lecture_publications WHERE shared_lecture_id=?', [shared.id]);
    for (const groupId of groupIds) await connection.execute('INSERT INTO instructor_shared_lecture_publications(id,shared_lecture_id,grade_id,group_id) VALUES (?,?,?,?)', [randomUUID(), shared.id, gradeId, groupId]);
    await connection.execute('UPDATE instructor_shared_lectures SET is_published=1 WHERE id=?', [shared.id]);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  return res.json({ published: true, grade_id: gradeId, group_ids: groupIds });
});

export default router;
