import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import Hls from 'hls.js';
import { Loader2, X, Play, Pause, Volume2, VolumeX, Maximize, Minimize, RotateCcw, RotateCw, Shield } from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

interface SecureVideoPlayerProps {
    videoId: string;
    userId: string;
    studentName: string;
    groupName: string;
    onClose: () => void;
    directUrl?: string; // For external videos (YouTube, Drive, etc)
}

export function SecureVideoPlayer({
    videoId,
    userId,
    studentName,
    groupName,
    onClose,
    directUrl
}: SecureVideoPlayerProps) {
    const navigate = useNavigate();
    const videoRef = useRef<HTMLVideoElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const hlsRef = useRef<Hls | null>(null);

    const [loading, setLoading] = useState(true);
    const [buffering, setBuffering] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [isMuted, setIsMuted] = useState(false);
    const [volume, setVolume] = useState(1);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [progress, setProgress] = useState(0);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [showControls, setShowControls] = useState(true);
    const [securityViolation, setSecurityViolation] = useState<string | null>(null);
    const [isSecurityBlurred, setIsSecurityBlurred] = useState(false);
    const [showBlackScreen, setShowBlackScreen] = useState(false);
    const [sourceType, setSourceType] = useState<'hls' | 'mp4' | 'youtube' | 'drive' | 'unknown'>('unknown');
    const [embedUrl, setEmbedUrl] = useState<string>('');

    const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const isLoggedOutRef = useRef(false);
    const animationFrameRef = useRef<number | null>(null);

    // Watermark text
    const watermarkText = `${studentName} • ${groupName} • ${userId.slice(-4)}`;

    // CANVAS WATERMARK RENDERER
    const renderWatermarks = useCallback(() => {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        if (canvas.width !== container.clientWidth || canvas.height !== container.clientHeight) {
            canvas.width = container.clientWidth;
            canvas.height = container.clientHeight;
        }

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const time = Date.now() / 2000;
        const count = 15;

        for (let i = 0; i < count; i++) {
            const x = (Math.sin(time + i) * 0.5 + 0.5) * canvas.width;
            const y = (Math.cos(time * 0.7 + i * 2) * 0.5 + 0.5) * canvas.height;

            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(-0.5 + Math.sin(time + i) * 0.2);
            // Increased opacity significantly to 0.2 - 0.4
            ctx.globalAlpha = 0.25 + Math.sin(time * 2 + i) * 0.15;
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 18px sans-serif';
            ctx.fillText(watermarkText, 0, 0);
            ctx.restore();
        }

        // Center big watermark
        ctx.save();
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(-0.5);
        ctx.globalAlpha = 0.15; // Increased from 0.03
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 40px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(watermarkText, 0, 0);
        ctx.restore();

        // Version/Protection Indicator (To verify deployment)
        ctx.save();
        ctx.font = '12px monospace';
        ctx.fillStyle = 'rgba(0, 255, 0, 0.5)';
        ctx.fillText('Protected Mode v2.2 Active', 10, canvas.height - 10);
        ctx.restore();

        animationFrameRef.current = requestAnimationFrame(renderWatermarks);
    }, [watermarkText]);

    useEffect(() => {
        renderWatermarks();
        return () => {
            if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
        };
    }, [renderWatermarks]);

    // FORCE LOGOUT
    const forceLogout = useCallback((reason: string) => {
        if (isLoggedOutRef.current) return;
        isLoggedOutRef.current = true;

        fetch(`${API_BASE}/videos/security/log`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, videoId, activityType: 'violation', details: reason })
        }).catch(console.error);

        setSecurityViolation(reason);
        navigate('/auth', { replace: true });
        window.location.reload();
    }, [userId, videoId, navigate]);

    // PREPARE EXTERNAL URLS
    const getEmbedUrl = (url: string) => {
        // YouTube
        if (url.includes('youtube.com') || url.includes('youtu.be')) {
            let id = '';
            if (url.includes('v=')) id = url.split('v=')[1]?.split('&')[0];
            else if (url.includes('youtu.be/')) id = url.split('youtu.be/')[1]?.split('?')[0];
            else if (url.includes('embed/')) id = url.split('embed/')[1]?.split('?')[0];

            if (id) return { type: 'youtube', url: `https://www.youtube.com/embed/${id}?autoplay=1&controls=1&modestbranding=1&rel=0` };
        }

        // Google Drive
        if (url.includes('drive.google.com')) {
            // Ensure preview mode
            const cleanUrl = url.replace('/view', '/preview').replace('/edit', '/preview');
            return { type: 'drive', url: cleanUrl };
        }

        return { type: 'unknown', url };
    };

    // LOAD VIDEO
    useEffect(() => {
        setLoading(true);

        const setupVideo = async () => {
            try {
                let finalUrl = directUrl || '';

                // If no direct URL, fetch from API
                if (!directUrl) {
                    const response = await fetch(`${API_BASE}/videos/stream/${videoId}?userId=${userId}`);
                    if (!response.ok) throw new Error('Failed to load video');
                    const data = await response.json();
                    finalUrl = data.streamUrl.startsWith('http') ? data.streamUrl : `${window.location.origin}${data.streamUrl}`;
                }

                // Check type
                if (finalUrl.includes('youtube') || finalUrl.includes('youtu.be')) {
                    const { type, url } = getEmbedUrl(finalUrl);
                    setSourceType(type as any);
                    setEmbedUrl(url);
                    setLoading(false);
                } else if (finalUrl.includes('drive.google.com')) {
                    const { type, url } = getEmbedUrl(finalUrl);
                    setSourceType(type as any);
                    setEmbedUrl(url);
                    setLoading(false);
                } else if (finalUrl.includes('.m3u8')) {
                    setSourceType('hls');
                    // Setup HLS...
                    if (videoRef.current && Hls.isSupported()) {
                        const hls = new Hls({
                            xhrSetup: (xhr, url) => {
                                if (url.includes('/key/')) {
                                    xhr.open('GET', `${url}${url.includes('?') ? '&' : '?'}userId=${userId}`, true);
                                }
                            }
                        });
                        hlsRef.current = hls;
                        hls.loadSource(finalUrl);
                        hls.attachMedia(videoRef.current);
                        hls.on(Hls.Events.MANIFEST_PARSED, () => {
                            setLoading(false);
                            videoRef.current?.play().catch(() => { });
                        });
                    }
                } else {
                    setSourceType('mp4');
                    if (videoRef.current) {
                        videoRef.current.src = finalUrl;
                        videoRef.current.play().catch(() => { });
                        setLoading(false);
                    }
                }
            } catch (err: any) {
                setError(err.message);
                setLoading(false);
            }
        };

        setupVideo();

        return () => {
            if (hlsRef.current) hlsRef.current.destroy();
            if (videoRef.current) {
                videoRef.current.pause();
                videoRef.current.src = '';
                videoRef.current.load();
            }
        };
    }, [videoId, userId, directUrl]);

    // ANTI-RECORDING EVENTS
    useEffect(() => {
        // ✅ Instead of forceLogout on visibility/blur, just pause the video
        // This prevents false-positive logouts from notifications, address bar clicks, etc.

        const handleVisibilityChange = () => {
            if (document.hidden && videoRef.current) {
                // Just pause the video when tab is hidden — don't logout
                videoRef.current.pause();
                console.log('⏸️ Video paused - tab hidden');
            }
        };

        const handleKeyDown = (e: KeyboardEvent) => {
            // Block PrintScreen and screen recording shortcuts
            if (e.key === 'PrintScreen') {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                videoRef.current?.pause();
                setShowBlackScreen(true);
                forceLogout('محاولة تصوير الشاشة (PrintScreen)');
                return;
            }

            // Block F12 (DevTools), Ctrl+U (view source), Ctrl+Shift+I (DevTools)
            if (e.key === 'F12' ||
                (e.ctrlKey && e.key.toLowerCase() === 'u') ||
                (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'i')) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            }
        };

        const handleContextMenu = (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            return false;
        };

        // Add Listeners with CAPTURE phase to catch events early
        document.addEventListener('visibilitychange', handleVisibilityChange, true);
        window.addEventListener('keydown', handleKeyDown, true);
        window.addEventListener('contextmenu', handleContextMenu, true);

        // Disable Screen Capture API
        if (navigator.mediaDevices) {
            // @ts-ignore
            navigator.mediaDevices.getDisplayMedia = () => {
                forceLogout('محاولة تسجيل الشاشة');
                return Promise.reject('Blocked');
            };
        }

        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange, true);
            window.removeEventListener('keydown', handleKeyDown, true);
            window.removeEventListener('contextmenu', handleContextMenu, true);
        };
    }, [forceLogout]);

    return (
        <div ref={containerRef} className="fixed inset-0 z-[9999] bg-black flex items-center justify-center select-none overflow-hidden">

            {/* VIOLATION SCREEN */}
            {(securityViolation) && (
                <div className="absolute inset-0 z-[10000] bg-black flex flex-col items-center justify-center text-white">
                    <Shield className="w-24 h-24 text-red-600 mb-6 animate-pulse" />
                    <h2 className="text-3xl font-bold mb-2">تم اكتشاف انتهاك أمني!</h2>
                    <p className="text-xl text-gray-400">جاري تسجيل الخروج...</p>
                </div>
            )}

            {/* VIDEO CONTENT */}
            {sourceType === 'youtube' || sourceType === 'drive' ? (
                <iframe
                    src={embedUrl}
                    className="w-full h-full object-contain pointer-events-auto"
                    allow="autoplay; encrypted-media; fullscreen"
                    allowFullScreen
                    style={{ pointerEvents: 'auto' }} // Enable controls for iframe
                />
            ) : (
                <video
                    ref={videoRef}
                    className="w-full h-full object-contain"
                    playsInline
                    disablePictureInPicture
                    // @ts-ignore
                    controlsList="nodownload nofullscreen noremoteplayback"
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                />
            )}

            {/* CANVAS WATERMARK (Always On Top) */}
            <canvas
                ref={canvasRef}
                className="absolute inset-0 pointer-events-none z-[50]"
            />

            {/* CONTROLS (Only for Native Video) */}
            {(sourceType === 'hls' || sourceType === 'mp4') && !loading && !error && showControls && (
                <div className="absolute inset-0 z-[60] flex flex-col justify-between p-6 bg-gradient-to-b from-black/80 via-transparent to-black/80">
                    <div className="flex justify-between items-center">
                        <button onClick={onClose} className="p-2 bg-white/10 rounded-full hover:bg-white/20 text-white">
                            <X className="w-6 h-6" />
                        </button>
                    </div>
                    {/* Add play/pause controls here if needed, or rely on video click */}
                </div>
            )}

            {/* CLOSE BUTTON FOR IFRAMES */}
            {(sourceType === 'youtube' || sourceType === 'drive') && (
                <button onClick={onClose} className="absolute top-6 left-6 z-[70] p-3 bg-red-600 rounded-full hover:bg-red-700 text-white shadow-lg">
                    <X className="w-6 h-6" />
                </button>
            )}

            {loading && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-[80] pointer-events-none">
                    <Loader2 className="w-12 h-12 text-blue-500 animate-spin" />
                </div>
            )}
        </div>
    );
}
