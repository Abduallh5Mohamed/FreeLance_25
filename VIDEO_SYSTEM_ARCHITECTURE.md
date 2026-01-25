# 🎬 نظام الفيديو الجديد - Self-Hosted Video Streaming System

## 📋 Overview

This document outlines a complete self-hosted video streaming solution using:
- **MinIO** - S3-compatible object storage (FREE)
- **FFmpeg** - Video processing & HLS conversion (FREE)
- **Node.js** - Backend API
- **HLS.js** - Browser video player

---

## 🏗️ System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           UPLOAD FLOW (Teacher)                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────┐    1. Request Upload    ┌─────────┐                           │
│  │ Teacher │ ─────────────────────▶  │ Node.js │                           │
│  │ Browser │                         │   API   │                           │
│  └────┬────┘                         └────┬────┘                           │
│       │                                   │                                 │
│       │                        2. Generate Presigned URL                    │
│       │                                   │                                 │
│       │    3. Return Presigned URL       │                                 │
│       │ ◀────────────────────────────────┘                                 │
│       │                                                                     │
│       │    4. Direct Chunk Upload (Resumable)                              │
│       │                                   ┌─────────┐                       │
│       └──────────────────────────────────▶│  MinIO  │                       │
│                                           │ Storage │                       │
│                                           └────┬────┘                       │
│                                                │                            │
│                                    5. Upload Complete                       │
│                                                │                            │
│                                                ▼                            │
│                                           ┌─────────┐                       │
│                                           │ FFmpeg  │                       │
│                                           │  Queue  │◀── Background Process │
│                                           └────┬────┘                       │
│                                                │                            │
│                                    6. Convert to HLS                        │
│                                                │                            │
│                                                ▼                            │
│                                           ┌─────────┐                       │
│                                           │   HLS   │                       │
│                                           │  Files  │                       │
│                                           └─────────┘                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                          STREAMING FLOW (Student)                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────┐    1. Request Video     ┌─────────┐                           │
│  │ Student │ ─────────────────────▶  │ Node.js │                           │
│  │ Browser │                         │   API   │                           │
│  └────┬────┘                         └────┬────┘                           │
│       │                                   │                                 │
│       │                    2. Check Subscription & Auth                     │
│       │                                   │                                 │
│       │    3. Return Signed HLS URL      │                                 │
│       │ ◀────────────────────────────────┘                                 │
│       │                                                                     │
│       │    4. Stream HLS (via signed URL)                                  │
│       │                                   ┌─────────┐                       │
│       └──────────────────────────────────▶│  MinIO  │                       │
│                                           │   HLS   │                       │
│                                           └─────────┘                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 🗄️ Database Schema

```sql
-- Videos table (main video metadata)
CREATE TABLE videos (
    id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    
    -- Ownership
    course_id VARCHAR(36) NOT NULL,
    lecture_id VARCHAR(36),
    material_id VARCHAR(36),
    uploaded_by VARCHAR(36) NOT NULL,
    
    -- Video Info
    title VARCHAR(255) NOT NULL,
    description TEXT,
    duration_seconds INT,
    file_size_bytes BIGINT,
    
    -- Storage Paths (MinIO)
    original_key VARCHAR(500),           -- videos/originals/{uuid}.mp4
    hls_key VARCHAR(500),                -- videos/hls/{uuid}/playlist.m3u8
    thumbnail_key VARCHAR(500),          -- videos/thumbnails/{uuid}.jpg
    
    -- Processing Status
    status ENUM('uploading', 'processing', 'ready', 'failed') DEFAULT 'uploading',
    processing_progress INT DEFAULT 0,   -- 0-100
    processing_error TEXT,
    
    -- Quality Options Generated
    qualities_available JSON,            -- ["360p", "720p"]
    
    -- Security
    is_drm_protected BOOLEAN DEFAULT FALSE,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    processed_at TIMESTAMP,
    
    -- Indexes
    INDEX idx_course (course_id),
    INDEX idx_status (status),
    INDEX idx_lecture (lecture_id),
    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
    FOREIGN KEY (uploaded_by) REFERENCES users(id)
);

-- Video upload chunks tracking (for resumable uploads)
CREATE TABLE video_upload_chunks (
    id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    video_id VARCHAR(36) NOT NULL,
    upload_id VARCHAR(100) NOT NULL,     -- MinIO multipart upload ID
    chunk_number INT NOT NULL,
    chunk_size BIGINT NOT NULL,
    etag VARCHAR(100),                   -- MinIO ETag for verification
    status ENUM('pending', 'uploaded', 'failed') DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE KEY unique_chunk (video_id, chunk_number),
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

-- Video access logs (for analytics)
CREATE TABLE video_access_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    video_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    watch_duration_seconds INT DEFAULT 0,
    ip_address VARCHAR(45),
    user_agent VARCHAR(500),
    
    INDEX idx_video (video_id),
    INDEX idx_user (user_id),
    INDEX idx_accessed (accessed_at)
);

-- Video processing queue
CREATE TABLE video_processing_queue (
    id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    video_id VARCHAR(36) NOT NULL,
    priority INT DEFAULT 0,
    status ENUM('pending', 'processing', 'completed', 'failed') DEFAULT 'pending',
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    error_message TEXT,
    worker_id VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE KEY unique_video (video_id),
    INDEX idx_status_priority (status, priority DESC),
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);
```

---

## 📦 Required Packages

### Backend (server/package.json additions)
```json
{
  "dependencies": {
    "minio": "^7.1.3",
    "fluent-ffmpeg": "^2.1.2",
    "bull": "^4.12.2",
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "@types/fluent-ffmpeg": "^2.1.21"
  }
}
```

### Frontend (package.json additions)
```json
{
  "dependencies": {
    "hls.js": "^1.5.7",
    "tus-js-client": "^4.1.0"
  }
}
```

---

## 🔧 Server Setup on VPS

### 1. Install MinIO
```bash
# Download MinIO binary
wget https://dl.min.io/server/minio/release/linux-amd64/minio
chmod +x minio
sudo mv minio /usr/local/bin/

# Create MinIO data directory
sudo mkdir -p /data/minio
sudo chown -R $USER:$USER /data/minio

# Create MinIO service
sudo nano /etc/systemd/system/minio.service
```

MinIO service file:
```ini
[Unit]
Description=MinIO
After=network.target

[Service]
User=root
Group=root
Environment="MINIO_ROOT_USER=minioadmin"
Environment="MINIO_ROOT_PASSWORD=YOUR_SECURE_PASSWORD_HERE"
ExecStart=/usr/local/bin/minio server /data/minio --console-address ":9001"
Restart=always
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

```bash
# Start MinIO
sudo systemctl daemon-reload
sudo systemctl enable minio
sudo systemctl start minio
```

### 2. Install FFmpeg
```bash
# Ubuntu/Debian
sudo apt update
sudo apt install ffmpeg -y

# Verify
ffmpeg -version
```

### 3. Create MinIO Buckets (via MinIO Console or CLI)
```bash
# Install MinIO client
wget https://dl.min.io/client/mc/release/linux-amd64/mc
chmod +x mc
sudo mv mc /usr/local/bin/

# Configure MinIO client
mc alias set myminio http://localhost:9000 minioadmin YOUR_SECURE_PASSWORD_HERE

# Create buckets
mc mb myminio/videos-original     # For original uploads
mc mb myminio/videos-hls          # For HLS processed files
mc mb myminio/videos-thumbnails   # For thumbnails
```

---

## 🔐 Environment Variables

Add to `server/.env`:
```env
# MinIO Configuration
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_USE_SSL=false
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=YOUR_SECURE_PASSWORD_HERE

# Buckets
MINIO_BUCKET_ORIGINALS=videos-original
MINIO_BUCKET_HLS=videos-hls
MINIO_BUCKET_THUMBNAILS=videos-thumbnails

# Video Processing
VIDEO_MAX_SIZE_MB=5000
VIDEO_CHUNK_SIZE_MB=10
FFMPEG_THREADS=2
HLS_SEGMENT_DURATION=10

# Signed URL expiration (seconds)
SIGNED_URL_EXPIRY=600
```

---

## 🚀 Implementation Files

The implementation is split into these components:

1. **MinIO Service** - [server/src/services/minio.ts](server/src/services/minio.ts)
2. **Video Processing Service** - [server/src/services/video-processor.ts](server/src/services/video-processor.ts)
3. **Video Routes** - [server/src/routes/videos.ts](server/src/routes/videos.ts)
4. **Frontend Upload Component** - [src/components/VideoUploader.tsx](src/components/VideoUploader.tsx)
5. **HLS Player Component** - [src/components/HLSVideoPlayer.tsx](src/components/HLSVideoPlayer.tsx)

---

## 📊 Performance Considerations

### VPS Minimum Specs
- **CPU**: 2+ cores (FFmpeg is CPU intensive)
- **RAM**: 4GB minimum (8GB recommended)
- **Storage**: SSD preferred, size depends on video library
- **Bandwidth**: Depends on concurrent students

### Optimization Tips
1. **Limit concurrent transcoding** - Max 1-2 videos at a time
2. **Use 360p + 720p only** - Skip 1080p for educational content
3. **Enable MinIO caching** - Frequently accessed segments
4. **Set up CDN** (optional) - CloudFlare free tier for additional caching

---

## ⚠️ Limitations & Trade-offs

| Aspect | Trade-off |
|--------|-----------|
| **Cost** | ✅ Very low (VPS only) |
| **Scalability** | ⚠️ Limited by VPS resources |
| **Reliability** | ⚠️ Single point of failure (no redundancy) |
| **Max Concurrent Users** | ~50-100 on decent VPS |
| **Processing Speed** | ⚠️ Slower than cloud services |
| **Global Latency** | ⚠️ Single location |

### Mitigation Strategies
- Use CloudFlare (free) for caching and DDoS protection
- Schedule heavy processing during off-peak hours
- Implement video quality auto-selection based on network

---

## 🔄 Migration from Google Drive

1. Videos already uploaded to Drive will continue to work
2. New videos will use the new system
3. Optional: Batch download and re-process old Drive videos

---

## 📝 Next Steps

1. Install MinIO on VPS
2. Install FFmpeg on VPS
3. Run database migrations
4. Deploy updated server code
5. Update frontend components
6. Test with small video first
7. Monitor server resources during processing
