import SimpleVideoPlayer from '@/components/SimpleVideoPlayer';

export default function TestVideoPage() {
    // Get user from localStorage
    const userStr = localStorage.getItem('user');
    const user = userStr ? JSON.parse(userStr) : null;
    const userId = user?.id || 'test-user';

    return (
        <div style={{ padding: 20 }}>
            <h1>Video Test Page</h1>
            <p>User ID: {userId}</p>
            <SimpleVideoPlayer
                videoId="e0acff5d-f093-4307-8792-eadeccc2683e"
                userId={userId}
            />
        </div>
    );
}
