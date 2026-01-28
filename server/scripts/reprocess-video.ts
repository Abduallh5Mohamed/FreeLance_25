import fetch from 'node-fetch';

const VIDEO_ID = '3207d96d-e2b4-4258-aa02-da3e7ec62249';
const API_URL = 'http://localhost:3001/api';

async function reprocessVideo() {
    console.log(`Triggering reprocessing for video ${VIDEO_ID}...`);
    try {
        const response = await fetch(`${API_URL}/videos/${VIDEO_ID}/reprocess`, {
            method: 'POST'
        });

        const data = await response.json();
        console.log('Response:', data);

        if (response.ok) {
            console.log('✅ Reprocessing triggered successfully');
        } else {
            console.error('❌ Failed to trigger reprocessing:', data);
        }
    } catch (error) {
        console.error('❌ Error:', error);
    }
}

reprocessVideo();
