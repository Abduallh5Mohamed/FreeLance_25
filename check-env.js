require('dotenv').config();
console.log('ACCESS:', process.env.MINIO_ACCESS_KEY);
console.log('SECRET:', process.env.MINIO_SECRET_KEY);
console.log('ENDPOINT:', process.env.MINIO_ENDPOINT);
console.log('PORT:', process.env.MINIO_PORT);
