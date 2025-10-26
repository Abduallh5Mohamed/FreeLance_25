-- Update course-materials bucket to allow larger file sizes (up to 500MB for videos)
UPDATE storage.buckets 
SET 
  file_size_limit = 524288000, -- 500MB in bytes
  allowed_mime_types = ARRAY[
    'application/pdf',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
    'video/mp4',
    'video/x-msvideo',
    'video/quicktime',
    'video/x-ms-wmv',
    'video/x-matroska',
    'video/x-flv',
    'video/webm'
  ]
WHERE id = 'course-materials';