-- ====================================
-- MySQL Database Schema
-- Educational Platform - Al-Qaed
-- Converted from Supabase PostgreSQL
-- ====================================

DROP DATABASE IF EXISTS Freelance;
CREATE DATABASE Freelance CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE Freelance;

-- ====================================
-- Users and Authentication Tables
-- ====================================

CREATE TABLE users (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  email VARCHAR(255) UNIQUE,
  phone VARCHAR(50) UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  role ENUM('admin', 'teacher', 'student') DEFAULT 'student',
  is_active BOOLEAN DEFAULT TRUE,
  email_verified BOOLEAN DEFAULT FALSE,
  phone_verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_email (email),
  INDEX idx_phone (phone),
  INDEX idx_role (role)
) ENGINE=InnoDB;

CREATE TABLE user_roles (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  user_id CHAR(36) NOT NULL,
  role ENUM('admin', 'teacher', 'student') NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_user_role (user_id, role),
  INDEX idx_user_id (user_id)
) ENGINE=InnoDB;

-- ====================================
-- Grades Tables
-- ====================================

CREATE TABLE grades (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  name VARCHAR(255) NOT NULL,
  display_order INT DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_active (is_active)
) ENGINE=InnoDB;

-- ====================================
-- Students Tables
-- ====================================

CREATE TABLE students (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE,
  phone VARCHAR(50),
  grade VARCHAR(100),
  grade_id CHAR(36),
  group_id CHAR(36),
  barcode VARCHAR(50) UNIQUE,
  is_offline BOOLEAN DEFAULT FALSE,
  password_hash VARCHAR(255),
  approval_status ENUM('pending', 'approved', 'rejected') DEFAULT 'approved',
  parent_phone VARCHAR(50),
  address TEXT,
  notes TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE SET NULL,
  INDEX idx_email (email),
  INDEX idx_barcode (barcode),
  INDEX idx_grade_id (grade_id),
  INDEX idx_group_id (group_id),
  INDEX idx_approval_status (approval_status)
) ENGINE=InnoDB;

CREATE TABLE student_registration_requests (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NULL DEFAULT NULL,
  phone VARCHAR(50),
  grade_id CHAR(36),
  group_id CHAR(36),
  password_hash VARCHAR(255),
  requested_courses JSON,
  status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
  rejection_reason TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE SET NULL,
  INDEX idx_status (status),
  INDEX idx_email (email)
) ENGINE=InnoDB;

-- ====================================
-- Courses Tables
-- ====================================

CREATE TABLE courses (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  name VARCHAR(255) NOT NULL,
  subject VARCHAR(100),
  description TEXT,
  grade VARCHAR(100),
  is_active BOOLEAN DEFAULT TRUE,
  price DECIMAL(10, 2) DEFAULT 0,
  duration_months INT DEFAULT 3,
  thumbnail_url VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_subject (subject),
  INDEX idx_grade (grade),
  INDEX idx_active (is_active)
) ENGINE=InnoDB;

CREATE TABLE student_courses (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  student_id CHAR(36) NOT NULL,
  course_id CHAR(36) NOT NULL,
  enrollment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  status ENUM('active', 'completed', 'dropped') DEFAULT 'active',
  progress DECIMAL(5, 2) DEFAULT 0,
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
  UNIQUE KEY unique_student_course (student_id, course_id),
  INDEX idx_student_id (student_id),
  INDEX idx_course_id (course_id),
  INDEX idx_status (status)
) ENGINE=InnoDB;

-- ====================================
-- Groups Tables
-- ====================================

CREATE TABLE `groups` (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  course_id CHAR(36),
  max_students INT DEFAULT 30,
  current_students INT DEFAULT 0,
  schedule_days JSON,
  schedule_time TIME,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE SET NULL,
  INDEX idx_course_id (course_id),
  INDEX idx_active (is_active)
) ENGINE=InnoDB;

CREATE TABLE group_courses (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  group_id CHAR(36) NOT NULL,
  course_id CHAR(36) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
  UNIQUE KEY unique_group_course (group_id, course_id),
  INDEX idx_group_id (group_id),
  INDEX idx_course_id (course_id)
) ENGINE=InnoDB;

-- ====================================
-- Course Materials Tables
-- ====================================

CREATE TABLE course_materials (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  course_id CHAR(36) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  material_type ENUM('pdf', 'video', 'presentation', 'link', 'other') NOT NULL,
  file_url VARCHAR(500),
  file_size BIGINT,
  duration_minutes INT,
  display_order INT DEFAULT 0,
  is_free BOOLEAN DEFAULT FALSE,
  is_published BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
  INDEX idx_course_id (course_id),
  INDEX idx_type (material_type),
  INDEX idx_published (is_published)
) ENGINE=InnoDB;

CREATE TABLE material_groups (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  material_id CHAR(36) NOT NULL,
  group_id CHAR(36) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (material_id) REFERENCES course_materials(id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  UNIQUE KEY unique_material_group (material_id, group_id),
  INDEX idx_material_id (material_id),
  INDEX idx_group_id (group_id)
) ENGINE=InnoDB;

CREATE TABLE student_materials (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  student_id CHAR(36) NOT NULL,
  material_id CHAR(36) NOT NULL,
  viewed_at TIMESTAMP NULL,
  download_count INT DEFAULT 0,
  last_position INT DEFAULT 0,
  completed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (material_id) REFERENCES course_materials(id) ON DELETE CASCADE,
  UNIQUE KEY unique_student_material (student_id, material_id),
  INDEX idx_student_id (student_id),
  INDEX idx_material_id (material_id)
) ENGINE=InnoDB;

-- ====================================
-- Exams Tables
-- ====================================

CREATE TABLE exams (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  course_id CHAR(36) NOT NULL,
  duration_minutes INT DEFAULT 60,
  total_marks INT DEFAULT 100,
  passing_marks INT DEFAULT 50,
  exam_date DATE,
  start_time TIME,
  end_time TIME,
  is_active BOOLEAN DEFAULT TRUE,
  is_published BOOLEAN DEFAULT FALSE,
  allow_review BOOLEAN DEFAULT TRUE,
  shuffle_questions BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
  INDEX idx_course_id (course_id),
  INDEX idx_active (is_active),
  INDEX idx_exam_date (exam_date)
) ENGINE=InnoDB;

CREATE TABLE exam_questions (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  exam_id CHAR(36) NOT NULL,
  question_text TEXT NOT NULL,
  question_type ENUM('multiple_choice', 'true_false', 'essay', 'short_answer') DEFAULT 'multiple_choice',
  options JSON,
  correct_answer TEXT,
  points INT DEFAULT 1,
  explanation TEXT,
  display_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
  INDEX idx_exam_id (exam_id),
  INDEX idx_type (question_type)
) ENGINE=InnoDB;

CREATE TABLE exam_groups (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  exam_id CHAR(36) NOT NULL,
  group_id CHAR(36) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  UNIQUE KEY unique_exam_group (exam_id, group_id),
  INDEX idx_exam_id (exam_id),
  INDEX idx_group_id (group_id)
) ENGINE=InnoDB;

CREATE TABLE exam_results (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  exam_id CHAR(36) NOT NULL,
  student_id CHAR(36) NOT NULL,
  marks_obtained DECIMAL(10, 2) DEFAULT 0,
  total_marks DECIMAL(10, 2) NOT NULL,
  percentage DECIMAL(5, 2) GENERATED ALWAYS AS (
    CASE 
      WHEN total_marks > 0 THEN (marks_obtained / total_marks * 100)
      ELSE 0 
    END
  ) STORED,
  grade VARCHAR(10),
  remarks TEXT,
  submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  graded_at TIMESTAMP NULL,
  graded_by CHAR(36),
  FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (graded_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY unique_student_exam (student_id, exam_id),
  INDEX idx_exam_id (exam_id),
  INDEX idx_student_id (student_id),
  INDEX idx_submitted_at (submitted_at)
) ENGINE=InnoDB;

CREATE TABLE exam_student_answers (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  exam_id CHAR(36) NOT NULL,
  student_id CHAR(36) NOT NULL,
  question_id CHAR(36) NOT NULL,
  student_answer TEXT,
  is_correct BOOLEAN DEFAULT FALSE,
  points_earned DECIMAL(10, 2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (question_id) REFERENCES exam_questions(id) ON DELETE CASCADE,
  UNIQUE KEY unique_student_question (student_id, question_id),
  INDEX idx_exam_id (exam_id),
  INDEX idx_student_id (student_id),
  INDEX idx_question_id (question_id)
) ENGINE=InnoDB;

-- ====================================
-- Attendance Tables
-- ====================================

CREATE TABLE attendance (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  student_id CHAR(36) NOT NULL,
  course_id CHAR(36),
  group_id CHAR(36),
  attendance_date DATE NOT NULL,
  attendance_time TIME,
  status ENUM('present', 'absent', 'late', 'excused') DEFAULT 'absent',
  notes TEXT,
  marked_by CHAR(36),
  method ENUM('manual', 'qr', 'barcode') DEFAULT 'manual',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE SET NULL,
  FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE SET NULL,
  FOREIGN KEY (marked_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_student_id (student_id),
  INDEX idx_date (attendance_date),
  INDEX idx_status (status),
  INDEX idx_group_id (group_id)
) ENGINE=InnoDB;

CREATE TABLE attendance_qr_codes (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  group_id CHAR(36) NOT NULL,
  course_id CHAR(36),
  qr_code_data TEXT NOT NULL,
  valid_from TIMESTAMP NOT NULL,
  valid_until TIMESTAMP NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  max_scans INT DEFAULT 100,
  scan_count INT DEFAULT 0,
  created_by CHAR(36),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_group_id (group_id),
  INDEX idx_active (is_active),
  INDEX idx_valid_until (valid_until)
) ENGINE=InnoDB;

-- ====================================
-- Financial Tables
-- ====================================

CREATE TABLE subscriptions (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  student_id CHAR(36) NOT NULL,
  course_id CHAR(36) NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  payment_date DATE,
  due_date DATE,
  status ENUM('pending', 'paid', 'overdue', 'cancelled') DEFAULT 'pending',
  payment_method VARCHAR(50),
  transaction_id VARCHAR(100),
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
  INDEX idx_student_id (student_id),
  INDEX idx_course_id (course_id),
  INDEX idx_status (status),
  INDEX idx_due_date (due_date)
) ENGINE=InnoDB;

CREATE TABLE expenses (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  description TEXT NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  category VARCHAR(100),
  date DATE NOT NULL,
  time TIME,
  payment_method VARCHAR(50),
  recipient VARCHAR(255),
  notes TEXT,
  created_by CHAR(36),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_date (date),
  INDEX idx_category (category)
) ENGINE=InnoDB;

CREATE TABLE account_statement (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  transaction_type ENUM('income', 'expense') NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  description TEXT,
  category VARCHAR(100),
  date DATE NOT NULL,
  reference_id CHAR(36),
  reference_type VARCHAR(50),
  balance_after DECIMAL(10, 2),
  created_by CHAR(36),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_date (date),
  INDEX idx_type (transaction_type),
  INDEX idx_reference (reference_id, reference_type)
) ENGINE=InnoDB;

-- ====================================
-- Staff Tables
-- ====================================

CREATE TABLE staff (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE,
  phone VARCHAR(50),
  role VARCHAR(100),
  salary DECIMAL(10, 2),
  hire_date DATE,
  is_active BOOLEAN DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_email (email),
  INDEX idx_active (is_active)
) ENGINE=InnoDB;

-- ====================================
-- Messaging Tables
-- ====================================

CREATE TABLE teacher_messages (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  sender_id CHAR(36),
  recipient_id CHAR(36),
  message_text TEXT NOT NULL,
  is_read BOOLEAN DEFAULT FALSE,
  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  read_at TIMESTAMP NULL,
  FOREIGN KEY (sender_id) REFERENCES students(id) ON DELETE SET NULL,
  FOREIGN KEY (recipient_id) REFERENCES students(id) ON DELETE SET NULL,
  INDEX idx_sender (sender_id),
  INDEX idx_recipient (recipient_id),
  INDEX idx_read (is_read),
  INDEX idx_sent_at (sent_at)
) ENGINE=InnoDB;

-- ====================================
-- Online Meetings Tables
-- ====================================

CREATE TABLE online_meetings (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  meeting_url VARCHAR(500) NOT NULL,
  meeting_password VARCHAR(100),
  course_id CHAR(36),
  group_id CHAR(36),
  scheduled_at TIMESTAMP NOT NULL,
  duration_minutes INT DEFAULT 60,
  is_active BOOLEAN DEFAULT TRUE,
  created_by CHAR(36),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE SET NULL,
  FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_scheduled_at (scheduled_at),
  INDEX idx_course_id (course_id),
  INDEX idx_group_id (group_id)
) ENGINE=InnoDB;

-- ====================================
-- Imports Tables
-- ====================================

CREATE TABLE imports (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  import_type VARCHAR(50) NOT NULL,
  file_name VARCHAR(255),
  total_records INT DEFAULT 0,
  successful_records INT DEFAULT 0,
  failed_records INT DEFAULT 0,
  errors JSON,
  status ENUM('pending', 'processing', 'completed', 'failed') DEFAULT 'pending',
  imported_by CHAR(36),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP NULL,
  FOREIGN KEY (imported_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_type (import_type),
  INDEX idx_status (status),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB;

-- ====================================
-- Insert Initial Data
-- ====================================

-- Insert default admin user
INSERT INTO users (id, email, password_hash, name, role, email_verified) VALUES
(UUID(), 'hodabdh3@gmail.com', '$2a$10$YourHashedPasswordHere', 'الأستاذ محمد رمضان', 'admin', TRUE);

-- Insert default grades
INSERT INTO grades (name, display_order, is_active) VALUES
('الصف الأول الثانوي', 1, TRUE),
('الصف الثاني الثانوي', 2, TRUE),
('الصف الثالث الثانوي', 3, TRUE);

-- Insert default groups (مجاميع) matching the three grades
INSERT INTO `groups` (id, name, description, is_active) VALUES
(UUID(), 'الصف الأول الثانوي', 'مجموعة الصف الأول الثانوي', TRUE),
(UUID(), 'الصف الثاني الثانوي', 'مجموعة الصف الثاني الثانوي', TRUE),
(UUID(), 'الصف الثالث الثانوي', 'مجموعة الصف الثالث الثانوي', TRUE);

-- ====================================
-- Create Views for Analytics
-- ====================================

CREATE VIEW student_statistics AS
SELECT 
  s.id,
  s.name,
  s.email,
  COUNT(DISTINCT sc.course_id) as enrolled_courses,
  COUNT(DISTINCT a.id) as total_attendance,
  SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) as present_count,
  ROUND(AVG(er.percentage), 2) as avg_exam_score,
  s.created_at
FROM students s
LEFT JOIN student_courses sc ON s.id = sc.student_id
LEFT JOIN attendance a ON s.id = a.student_id
LEFT JOIN exam_results er ON s.id = er.student_id
WHERE s.is_active = TRUE
GROUP BY s.id;

CREATE VIEW course_statistics AS
SELECT 
  c.id,
  c.name,
  c.subject,
  COUNT(DISTINCT sc.student_id) as enrolled_students,
  COUNT(DISTINCT cm.id) as total_materials,
  COUNT(DISTINCT e.id) as total_exams,
  c.is_active,
  c.created_at
FROM courses c
LEFT JOIN student_courses sc ON c.id = sc.course_id
LEFT JOIN course_materials cm ON c.id = cm.course_id
LEFT JOIN exams e ON c.id = e.course_id
GROUP BY c.id;

CREATE VIEW financial_summary AS
SELECT 
  DATE(date) as summary_date,
  SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE 0 END) as total_income,
  SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END) as total_expense,
  SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE -amount END) as net_balance
FROM account_statement
GROUP BY DATE(date)
ORDER BY summary_date DESC;

-- ====================================
-- END OF SCHEMA
-- ====================================
