-- Create payment_requests table to track student payment submissions
CREATE TABLE IF NOT EXISTS payment_requests (
  id CHAR(36) PRIMARY KEY,
  student_name VARCHAR(255) NOT NULL,
  phone VARCHAR(50) NOT NULL,
  grade_id CHAR(36),
  grade_name VARCHAR(255),
  group_id CHAR(36),
  group_name VARCHAR(255),
  amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
  notes TEXT,
  receipt_image_url LONGTEXT,
  status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
