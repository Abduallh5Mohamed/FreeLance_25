import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { Loader2 } from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

interface SimpleVideoPlayerProps {
    videoId: string;
    userId: string;
}

export function SimpleVideoPlayer({ videoId, userId }: SimpleVideoPlayerProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const hlsRef = useRef<Hls | null>(null);
    const [loading, setLoading] = useState(true);
    const [buffering, setBuffering] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Buffering event handlers
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const handleWaiting = () => setBuffering(true);
        const handlePlaying = () => setBuffering(false);
        const handleCanPlay = () => setBuffering(false);

        video.addEventListener('waiting', handleWaiting);
        video.addEventListener('playing', handlePlaying);
        video.addEventListener('canplay', handleCanPlay);

        return () => {
            video.removeEventListener('waiting', handleWaiting);
            video.removeEventListener('playing', handlePlaying);
            video.removeEventListener('canplay', handleCanPlay);
        };
    }, []);

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        async function init() {
            try {
                setLoading(true);
                setError(null);

                const response = await fetch(`${API_BASE}/videos/stream/${videoId}?userId=${userId}`);
                const data = await response.json();

                if (!response.ok) {
                    setError(data.error || 'فشل تحميل الفيديو');
                    return;
                }

                const streamUrl = data.streamUrl;

                console.log('📹 Stream URL:', streamUrl);
                
                // Convert relative URL to absolute URL
                const fullStreamUrl = streamUrl.startsWith('http') 
                    ? streamUrl 
                    : `${window.location.origin}${streamUrl}`;
                console.log('📍 Full URL:', fullStreamUrl);

                // Check if HLS or direct video
                const isHLS = fullStreamUrl.includes('.m3u8');

                if (isHLS && Hls.isSupported()) {
                    const hls = new Hls({
                        enableWorker: true,
                        lowLatencyMode: false,
                        backBufferLength: 90,
                        maxBufferLength: 30,
                    });

                    hlsRef.current = hls;

                    hls.on(Hls.Events.ERROR, (_, data) => {
                        if (data.fatal) {
                            setError('حدث خطأ في تشغيل الفيديو');
                        }
                    });

                    hls.on(Hls.Events.MANIFEST_PARSED, () => {
                        setLoading(false);
                        video.play().catch(() => {
                            // Autoplay blocked, user needs to click
                        });
                    });

                    hls.loadSource(fullStreamUrl);
                    hls.attachMedia(video);
                } else if (isHLS && video.canPlayType('application/vnd.apple.mpegurl')) {
                    // Safari native HLS support
                    video.src = fullStreamUrl;
                    video.addEventListener('loadedmetadata', () => {
                        setLoading(false);
                        video.play();
                    });
                } else {
                    // Direct video file (mp4, webm, etc.) - Stream immediately like YouTube
                    console.log('▶️ Using direct video playback (progressive streaming)');
                    video.src = fullStreamUrl;

                    // Start playing as soon as we have ANY data (like YouTube)
                    video.addEventListener('loadeddata', () => {
                        console.log('✅ First frame loaded - starting playback');
                        setLoading(false);
                        video.play().catch(() => {
                            // Autoplay blocked, user needs to click
                        });
                    });

                    // Fallback: if loadeddata doesn't fire, use canplaythrough
                    video.addEventListener('canplaythrough', () => {
                        console.log('✅ Video can play through');
                        setLoading(false);
                    });

                    video.addEventListener('error', (e) => {
                        console.error('❌ Video error:', e);
                        console.error('❌ Video error code:', video.error?.code);
                        console.error('❌ Video error message:', video.error?.message);
                        setError(`فشل تحميل الفيديو (خطأ: ${video.error?.code})`);
                        setLoading(false);
                    });
                }
            } catch (err) {
                setError(err instanceof Error ? err.message : 'خطأ غير معروف');
                setLoading(false);
            }
        }

        init();

        return () => {
            if (hlsRef.current) {
                hlsRef.current.destroy();
                hlsRef.current = null;
            }
        };
    }, [videoId, userId]);

    return (
        <div className="relative w-full h-full min-h-[400px] bg-black flex items-center justify-center">
            {loading && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-10">
                    <Loader2 className="h-12 w-12 animate-spin text-white" />
                </div>
            )}

            {/* Buffering indicator (like YouTube) - shows when video is waiting for data */}
            {buffering && !loading && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
                    <div className="bg-black/40 rounded-full p-3">
                        <Loader2 className="h-10 w-10 animate-spin text-white" />
                    </div>
                </div>
            )}

            {error && (
                <div className="absolute inset-0 flex items-center justify-center bg-black z-10">
                    <div className="text-center text-white">
                        <p className="text-red-400 mb-2">❌ {error}</p>
                        <button
                            onClick={() => window.location.reload()}
                            className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-lg"
                        >
                            إعادة المحاولة
                        </button>
                    </div>
                </div>
            )}

            <video
                ref={videoRef}
                controls
                preload="auto"
                className="w-full h-full object-contain"
                style={{ maxHeight: '70vh' }}
                playsInline
            />
        </div>
    );
}

export default SimpleVideoPlayer;
