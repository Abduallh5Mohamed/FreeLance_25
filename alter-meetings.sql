ALTER TABLE online_meetings ADD COLUMN grade_id VARCHAR(36) AFTER meeting_password;
ALTER TABLE online_meetings ADD COLUMN meeting_type VARCHAR(20) DEFAULT 'zoom' AFTER meeting_url;
ALTER TABLE online_meetings RENAME COLUMN meeting_url TO meeting_link;
