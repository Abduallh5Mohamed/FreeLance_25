import * as Minio from 'minio';

const client = new Minio.Client({
    endPoint: 'localhost',
    port: 9000,
    useSSL: false,
    accessKey: 'minioadmin',
    secretKey: 'minioadmin123'
});

const buckets = ['videos-original', 'videos-hls', 'videos-thumbnails'];

async function checkBuckets() {
    for (const bucket of buckets) {
        const stream = client.listObjects(bucket, '', true);
        const objects = [];

        stream.on('data', obj => objects.push(obj));

        await new Promise((resolve, reject) => {
            stream.on('end', resolve);
            stream.on('error', reject);
        });

        console.log(`\n📦 Bucket: ${bucket}`);
        console.log(`📁 Files: ${objects.length}`);

        if (objects.length > 0) {
            console.table(objects.slice(0, 10).map(o => ({
                name: o.name,
                size: Math.round(o.size / 1024) + 'KB',
                modified: o.lastModified
            })));
        } else {
            console.log('⚠️  Empty bucket!');
        }
    }

    console.log('\n✅ Done');
}

checkBuckets().catch(console.error);
