-- Student identity is global; rows in `students` are tenant-scoped enrollments.
-- This migration is additive so legacy code can be migrated without data loss.

ALTER TABLE students
  ADD COLUMN user_id CHAR(36) NULL AFTER id,
  ADD COLUMN tenant_id CHAR(36) NULL AFTER instructor_id,
  ADD COLUMN guardian_name VARCHAR(255) NULL AFTER guardian_phone;

-- Backfill only deterministic matches. Ambiguous/unassigned rows deliberately
-- remain NULL and are visible to the platform data-quality report.
UPDATE students s
INNER JOIN users u ON u.role='student' AND u.phone=s.phone
SET s.user_id=u.id
WHERE s.user_id IS NULL;

UPDATE students s
INNER JOIN tenants t ON t.owner_user_id=s.instructor_id
SET s.tenant_id=t.id
WHERE s.tenant_id IS NULL AND s.instructor_id IS NOT NULL;

UPDATE students s
INNER JOIN `groups` g ON g.id=s.group_id
INNER JOIN tenants t ON t.owner_user_id=g.instructor_id
SET s.tenant_id=t.id, s.instructor_id=COALESCE(s.instructor_id,g.instructor_id)
WHERE s.tenant_id IS NULL;

-- Quarantine duplicate legacy memberships instead of guessing which duplicate
-- owns the identity. They remain visible to admins with user_id=NULL.
UPDATE students duplicate_row
INNER JOIN students canonical
  ON canonical.tenant_id=duplicate_row.tenant_id
 AND canonical.user_id=duplicate_row.user_id
 AND (canonical.created_at<duplicate_row.created_at OR
      (canonical.created_at=duplicate_row.created_at AND canonical.id<duplicate_row.id))
SET duplicate_row.user_id=NULL
WHERE duplicate_row.tenant_id IS NOT NULL AND duplicate_row.user_id IS NOT NULL;

ALTER TABLE students
  ADD INDEX idx_students_user (user_id),
  ADD UNIQUE KEY uq_students_tenant_user (tenant_id,user_id);

CREATE TABLE IF NOT EXISTS student_enrollment_invites (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  instructor_id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (instructor_id) REFERENCES users(id),
  INDEX idx_student_invite_owner (instructor_id,revoked_at,expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS student_enrollment_requests (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  instructor_id CHAR(36) NOT NULL,
  invite_id CHAR(36) NOT NULL,
  user_id CHAR(36) NULL,
  student_name VARCHAR(255) NOT NULL,
  phone VARCHAR(30) NOT NULL,
  guardian_name VARCHAR(255) NOT NULL,
  guardian_phone VARCHAR(30) NOT NULL,
  password_hash VARCHAR(255) NULL,
  grade_id CHAR(36) NOT NULL,
  group_id CHAR(36) NOT NULL,
  requested_courses JSON NULL,
  status ENUM('pending','approved','rejected','expired') NOT NULL DEFAULT 'pending',
  rejection_reason VARCHAR(1000) NULL,
  decided_by CHAR(36) NULL,
  decided_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (instructor_id) REFERENCES users(id),
  FOREIGN KEY (invite_id) REFERENCES student_enrollment_invites(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (grade_id) REFERENCES grades(id),
  FOREIGN KEY (group_id) REFERENCES `groups`(id),
  FOREIGN KEY (decided_by) REFERENCES users(id),
  INDEX idx_enrollment_request_owner (instructor_id,status,created_at),
  INDEX idx_enrollment_request_phone (tenant_id,phone,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS student_password_reset_requests (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  student_enrollment_id CHAR(36) NOT NULL,
  status ENUM('pending','approved','used','rejected','expired') NOT NULL DEFAULT 'pending',
  reset_token_hash CHAR(64) NULL UNIQUE,
  reset_expires_at DATETIME NULL,
  decided_by CHAR(36) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at DATETIME NULL,
  used_at DATETIME NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (student_enrollment_id) REFERENCES students(id),
  FOREIGN KEY (decided_by) REFERENCES users(id),
  INDEX idx_password_reset_owner (tenant_id,status,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rejected/expired request cleanup is run by the application scheduler. The
-- password hash is cleared immediately at decision time.
