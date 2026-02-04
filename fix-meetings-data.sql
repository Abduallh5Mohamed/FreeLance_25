-- Fix the corrupted Arabic text in the meetings table
-- The issue is that the data was stored with incorrect encoding

-- Delete the corrupted record
DELETE FROM online_meetings WHERE id = 'e4d70522-017e-11f1-a77e-94e8d4b653c4';

-- Re-insert with correct data
INSERT INTO online_meetings (
    id,
    title,
    description,
    meeting_link,
    meeting_type,
    meeting_password,
    grade_id,
    group_id,
    scheduled_at,
    duration_minutes,
    is_active,
    created_by,
    created_at,
    updated_at
) VALUES (
    'e4d70522-017e-11f1-a77e-94e8d4b653c4',
    'اجتماع الرياضيات',
    'اجتماع تعليمي للرياضيات',
    'https://meet.google.com/xhn-iqdf-yzc',
    'google_meet',
    NULL,
    '031d2f2a-c9b5-11f0-9d07-94e8d4b653c4',
    NULL,
    '2026-02-04 04:06:00',
    60,
    1,
    '69fe1174-c98d-11f0-9d07-94e8d4b653c4',
    '2026-02-04 04:06:34',
    '2026-02-04 04:06:34'
);

-- Verify the fix
SELECT id, title, description FROM online_meetings;
