// Test MinIO connection
import { initializeBuckets } from './src/services/minio';

async function testMinIO() {
    console.log('🧪 Testing MinIO connection...');

    try {
        await initializeBuckets();
        console.log('✅ MinIO connected successfully!');
        console.log('✅ All buckets are ready');
        process.exit(0);
    } catch (error) {
        console.error('❌ MinIO connection failed:', error);
        process.exit(1);
    }
}

testMinIO();
