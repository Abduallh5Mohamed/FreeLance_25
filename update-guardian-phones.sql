-- تحديث أرقام أولياء الأمور للطلاب
-- استبدل الأرقام دي بالأرقام الحقيقية

-- مثال:
UPDATE students SET guardian_phone = '01001234567' WHERE name = 'Baraa wael' AND phone = '01125721557';
UPDATE students SET guardian_phone = '01009876543' WHERE name = 'عمر';
UPDATE students SET guardian_phone = '01011223344' WHERE name = 'محمود';
UPDATE students SET guardian_phone = '01055667788' WHERE name = 'ali';

-- أو لو عايز تحط نفس رقم الطالب كولي أمر مؤقتاً:
-- UPDATE students SET guardian_phone = phone WHERE guardian_phone IS NULL;
