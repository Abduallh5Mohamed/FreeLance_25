-- Role values used by tenant owners and tenant staff.
ALTER TABLE users
  MODIFY COLUMN role ENUM('admin','teacher','student','instructor','staff') NOT NULL DEFAULT 'student';
