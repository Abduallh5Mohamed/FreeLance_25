const fs = require('fs');
const content = fs.readFileSync('/root/backend/services/minio.js', 'utf8');

// Fix presigned URLs to use nginx proxy
const fixedContent = content.replace(
  'return { uploadUrl, objectKey };',
  `// Convert MinIO URL to public proxy URL
    const publicUrl = uploadUrl.replace('http://localhost:9000', 'http://72.62.35.177/storage').replace('http://72.62.35.177:9000', 'http://72.62.35.177/storage');
    return { uploadUrl: publicUrl, objectKey };`
);

fs.writeFileSync('/root/backend/services/minio.js', fixedContent);
console.log('Fixed presigned URLs');
