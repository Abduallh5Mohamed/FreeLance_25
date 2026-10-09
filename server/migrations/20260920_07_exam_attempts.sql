-- جدول لتتبع محاولات الطلاب في الامتحانات
CREATE TABLE IF NOT EXISTS exam_attempts (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    exam_id CHAR(36) NOT NULL,
    student_id CHAR(36) NOT NULL,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL,
    score DECIMAL(5,2) NULL,
    status ENUM('in_progress', 'completed', 'abandoned') DEFAULT 'in_progress',
    answers JSON NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
    UNIQUE KEY unique_student_exam (student_id, exam_id)
) ENGINE=InnoDB;
