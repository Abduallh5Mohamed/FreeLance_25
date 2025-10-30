-- Create lectures table (separate from course_materials)
CREATE TABLE IF NOT EXISTS lectures (
    id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    course_id VARCHAR(36) NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    video_url VARCHAR(500) NOT NULL,
    duration_minutes INT,
    display_order INT DEFAULT 0,
    is_free BOOLEAN DEFAULT FALSE,
    is_published BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
    INDEX idx_course_id (course_id),
    INDEX idx_published (is_published)
);

-- Add comment to explain the difference
ALTER TABLE lectures COMMENT = 'Teacher lectures/videos uploaded via teacher-lectures page';
ALTER TABLE course_materials COMMENT = 'Course materials (PDFs, images, documents, etc.) uploaded via course-content page';
