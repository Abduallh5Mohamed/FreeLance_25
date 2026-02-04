require('dotenv').config();
const Minio = require('minio');

console.log('Testing MinIO connection...');
console.log('Using ACCESS:', process.env.MINIO_ACCESS_KEY);
console.log('Using SECRET:', process.env.MINIO_SECRET_KEY);
console.log('Using ENDPOINT:', process.env.MINIO_ENDPOINT);
console.log('Using PORT:', process.env.MINIO_PORT);

const client = new Minio.Client({
    endPoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: parseInt(process.env.MINIO_PORT || '9000'),
    useSSL: false,
    accessKey: process.env.MINIO_ACCESS_KEY,
    secretKey: process.env.MINIO_SECRET_KEY
});

client.listBuckets()
    .then(buckets => {
        console.log('SUCCESS! Buckets:', buckets);
    })
    .catch(err => {
        console.log('ERROR:', err.message, err.code);
    });
