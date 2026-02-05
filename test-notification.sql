INSERT INTO notifications (id, user_id, user_type, title, message, type)
VALUES (
  UUID(),
  (SELECT id FROM users WHERE role = 'admin' LIMIT 1),
  'admin',
  '🔔 مرحباً بك في نظام الإشعارات',
  'نظام الإشعارات جاهز الآن! ستصلك إشعارات عند أي حدث مهم.',
  'general'
);
