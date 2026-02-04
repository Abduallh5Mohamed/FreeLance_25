import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, X, Shield } from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

interface SecureYouTubePlayerProps {
    videoUrl: string;
    userId: string;
    studentName: string;
    groupName: string;
    title: string;
    onClose: () => void;
}

// Extract YouTube video ID from various URL formats
function extractYouTubeId(url: string): string | null {
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([^&\n?#]+)/,
        /youtube\.com\/shorts\/([^&\n?#]+)/,
    ];
    
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match && match[1]) {
            return match[1];
        }
    }
    return null;
}

// Convert Google Drive link to embed URL
function getGoogleDriveEmbedUrl(url: string): string | null {
    // Match patterns like /file/d/{fileId}/view or /file/d/{fileId}
    const match = url.match(/\/file\/d\/([^\/]+)/);
    if (match && match[1]) {
        return `https://drive.google.com/file/d/${match[1]}/preview`;
    }
    // Already a preview URL
    if (url.includes('/preview')) {
        return url;
    }
    return null;
}

// Detect video type
function detectVideoType(url: string): 'youtube' | 'drive' | 'unknown' {
    if (url.includes('youtube.com') || url.includes('youtu.be')) {
        return 'youtube';
    }
    if (url.includes('drive.google.com')) {
        return 'drive';
    }
    return 'unknown';
}

export function SecureYouTubePlayer({
    videoUrl,
    userId,
    studentName,
    groupName,
    title,
    onClose
}: SecureYouTubePlayerProps) {
    const navigate = useNavigate();
    const containerRef = useRef<HTMLDivElement>(null);
    const iframeRef = useRef<HTMLIFrameElement>(null);
    
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [securityViolation, setSecurityViolation] = useState<string | null>(null);
    const [showBlackScreen, setShowBlackScreen] = useState(false);
    const [watermarks, setWatermarks] = useState<Array<{ x: number; y: number; rotation: number; opacity: number }>>([]);

    const isLoggedOutRef = useRef(false);
    const suspiciousActivityCount = useRef(0);

    // Detect video type and get embed URL
    const videoType = detectVideoType(videoUrl);
    const youtubeId = extractYouTubeId(videoUrl);
    const driveEmbedUrl = getGoogleDriveEmbedUrl(videoUrl);
    
    // Build the embed URL based on video type - Maximum privacy & fullscreen
    const getEmbedUrl = (): string | null => {
        if (videoType === 'youtube' && youtubeId) {
            // Use youtube-nocookie.com for privacy, hide all branding possible
            return `https://www.youtube-nocookie.com/embed/${youtubeId}?autoplay=1&rel=0&modestbranding=1&showinfo=0&controls=1&fs=1&iv_load_policy=3&disablekb=0&playsinline=1`;
        }
        if (videoType === 'drive' && driveEmbedUrl) {
            return driveEmbedUrl;
        }
        return null;
    };
    
    const embedUrl = getEmbedUrl();
    const watermarkText = `${studentName} • ${groupName}`;

    // Generate watermarks covering the entire screen
    useEffect(() => {
        const generateWatermarks = () => {
            const marks = [];
            for (let row = 0; row < 10; row++) {
                for (let col = 0; col < 15; col++) {
                    marks.push({
                        x: (col * 7) + (Math.random() * 3),
                        y: (row * 10) + (Math.random() * 3),
                        rotation: Math.random() * 10 - 5,
                        opacity: 0.03 + Math.random() * 0.05
                    });
                }
            }
            setWatermarks(marks);
        };

        generateWatermarks();
        const interval = setInterval(generateWatermarks, 10000);
        return () => clearInterval(interval);
    }, []);

    // FORCE LOGOUT - Security violation detected
    const forceLogout = useCallback((reason: string) => {
        if (isLoggedOutRef.current) return;
        isLoggedOutRef.current = true;

        // Log security violation
        fetch(`${API_BASE}/videos/security/log`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId,
                videoId: videoUrl,
                activityType: reason.includes('تصوير') ? 'screenshot_attempt' :
                    reason.includes('تسجيل') ? 'recording_attempt' :
                        reason.includes('أدوات المطور') ? 'devtools_attempt' :
                            'forced_logout',
                details: reason
            })
        }).catch(err => console.error('Failed to log security event:', err));

        setSecurityViolation(reason);

        setTimeout(() => {
            localStorage.removeItem('user');
            localStorage.removeItem('token');
            sessionStorage.clear();

            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => { });
            }

            navigate('/auth', { replace: true });
            window.location.reload();
        }, 2000);
    }, [navigate, userId, videoUrl]);

    // Security measures
    useEffect(() => {
        // Block screen capture APIs
        const detectScreenCapture = async () => {
            try {
                const originalGetDisplayMedia = navigator.mediaDevices?.getDisplayMedia;
                if (originalGetDisplayMedia) {
                    navigator.mediaDevices.getDisplayMedia = function (...args) {
                        setShowBlackScreen(true);
                        forceLogout('محاولة تسجيل الشاشة - Screen Capture API');
                        throw new Error('Screen capture blocked');
                    };
                }

                const originalMediaRecorder = window.MediaRecorder;
                if (originalMediaRecorder) {
                    window.MediaRecorder = new Proxy(originalMediaRecorder, {
                        construct(target, args) {
                            setShowBlackScreen(true);
                            forceLogout('محاولة تسجيل الفيديو - MediaRecorder');
                            throw new Error('Recording blocked');
                        }
                    });
                }
            } catch (e) {
                console.log('Recording detection setup:', e);
            }
        };

        detectScreenCapture();

        // Block keyboard shortcuts for screenshot
        const handleKeyDown = (e: KeyboardEvent) => {
            // PrintScreen
            if (e.key === 'PrintScreen') {
                e.preventDefault();
                setShowBlackScreen(true);
                forceLogout('محاولة تصوير الشاشة - Print Screen');
                return;
            }
            
            // Ctrl+Shift+S (Windows screenshot)
            if (e.ctrlKey && e.shiftKey && e.key === 'S') {
                e.preventDefault();
                setShowBlackScreen(true);
                forceLogout('محاولة تصوير الشاشة');
                return;
            }
            
            // Cmd+Shift+3/4 (Mac screenshot)
            if (e.metaKey && e.shiftKey && (e.key === '3' || e.key === '4' || e.key === '5')) {
                e.preventDefault();
                setShowBlackScreen(true);
                forceLogout('محاولة تصوير الشاشة - Mac');
                return;
            }

            // DevTools shortcuts
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'I') {
                e.preventDefault();
                setShowBlackScreen(true);
                forceLogout('أدوات المطور');
                return;
            }
            
            if (e.key === 'F12') {
                e.preventDefault();
                setShowBlackScreen(true);
                forceLogout('أدوات المطور - F12');
                return;
            }
        };

        // Right-click prevention
        const handleContextMenu = (e: MouseEvent) => {
            e.preventDefault();
            return false;
        };

        // Visibility change detection - ONLY when tab is actually hidden (real tab switch)
        // This won't trigger when clicking on YouTube iframe controls
        const handleVisibilityChange = () => {
            if (document.hidden) {
                setShowBlackScreen(true);
                forceLogout('تبديل التبويب محظور أثناء المشاهدة');
            }
        };

        // NOTE: Removed blur detection completely because YouTube iframe
        // triggers blur when user clicks on video controls (play, seek, volume)

        // DevTools detection
        const detectDevTools = () => {
            const threshold = 160;
            const widthThreshold = window.outerWidth - window.innerWidth > threshold;
            const heightThreshold = window.outerHeight - window.innerHeight > threshold;

            if (widthThreshold || heightThreshold) {
                setShowBlackScreen(true);
                forceLogout('أدوات المطور مفتوحة');
            }
        };

        const devToolsInterval = setInterval(detectDevTools, 500);

        document.addEventListener('keydown', handleKeyDown);
        document.addEventListener('contextmenu', handleContextMenu);
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            clearInterval(devToolsInterval);
            document.removeEventListener('keydown', handleKeyDown);
            document.removeEventListener('contextmenu', handleContextMenu);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [forceLogout]);

    // Disable text selection and drag
    useEffect(() => {
        const style = document.createElement('style');
        style.innerHTML = `
            .secure-youtube-container * {
                -webkit-user-select: none !important;
                -moz-user-select: none !important;
                -ms-user-select: none !important;
                user-select: none !important;
                -webkit-touch-callout: none !important;
            }
        `;
        document.head.appendChild(style);
        return () => {
            document.head.removeChild(style);
        };
    }, []);

    // Close on Escape
    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            }
        };
        document.addEventListener('keydown', handleEscape);
        return () => document.removeEventListener('keydown', handleEscape);
    }, [onClose]);

    if (!embedUrl) {
        return (
            <div className="fixed inset-0 z-[9999] bg-black flex items-center justify-center">
                <div className="bg-red-900/90 p-8 rounded-lg text-center">
                    <p className="text-white text-xl">رابط الفيديو غير صالح</p>
                    <p className="text-white/70 text-sm mt-2">
                        يرجى التأكد من أن الرابط صحيح (YouTube أو Google Drive)
                    </p>
                    <button
                        onClick={onClose}
                        className="mt-4 px-6 py-2 bg-white text-black rounded-lg"
                    >
                        إغلاق
                    </button>
                </div>
            </div>
        );
    }

    // Security violation screen
    if (securityViolation) {
        return (
            <div className="fixed inset-0 z-[9999] bg-red-900 flex items-center justify-center">
                <div className="text-center p-8">
                    <Shield className="w-24 h-24 text-white mx-auto mb-4 animate-pulse" />
                    <h2 className="text-3xl font-bold text-white mb-4">⚠️ تحذير أمني</h2>
                    <p className="text-xl text-white mb-4">{securityViolation}</p>
                    <p className="text-lg text-red-200">جاري تسجيل الخروج...</p>
                </div>
            </div>
        );
    }

    return (
        <div 
            ref={containerRef}
            className="fixed inset-0 z-[9999] bg-black secure-youtube-container"
            style={{ 
                userSelect: 'none',
                WebkitUserSelect: 'none',
            }}
        >
            {/* Black screen for security */}
            {showBlackScreen && (
                <div className="absolute inset-0 z-[10001] bg-black" />
            )}

            {/* Close button - smaller and less intrusive */}
            <button
                onClick={onClose}
                className="absolute top-2 right-2 z-[10000] p-2 bg-red-600/80 hover:bg-red-700 rounded-full text-white transition-all opacity-70 hover:opacity-100"
            >
                <X className="w-5 h-5" />
            </button>

            {/* Security indicator - smaller */}
            <div className="absolute top-2 left-1/2 transform -translate-x-1/2 z-[10000] flex items-center gap-1 bg-green-600/60 px-3 py-1 rounded-full opacity-70">
                <Shield className="w-4 h-4 text-white" />
                <span className="text-white text-xs font-medium">وضع المشاهدة الآمنة</span>
            </div>

            {/* Loading */}
            {loading && (
                <div className="absolute inset-0 flex items-center justify-center z-[9998]">
                    <div className="text-center">
                        <Loader2 className="w-16 h-16 text-white animate-spin mx-auto mb-4" />
                        <p className="text-white text-lg">جاري تحميل الفيديو...</p>
                    </div>
                </div>
            )}

            {/* Video iframe - TRUE FULLSCREEN */}
            <div className="absolute inset-0 w-full h-full">
                <iframe
                    ref={iframeRef}
                    src={embedUrl}
                    className="w-full h-full"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                    allowFullScreen
                    onLoad={() => setLoading(false)}
                    style={{ 
                        border: 'none',
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: '100%',
                    }}
                />
            </div>

            {/* Watermarks overlay */}
            <div 
                className="absolute inset-0 pointer-events-none z-[9999] overflow-hidden"
                style={{ mixBlendMode: 'difference' }}
            >
                {watermarks.map((mark, index) => (
                    <div
                        key={index}
                        className="absolute text-white font-bold whitespace-nowrap"
                        style={{
                            left: `${mark.x}%`,
                            top: `${mark.y}%`,
                            transform: `rotate(${mark.rotation}deg)`,
                            opacity: mark.opacity,
                            fontSize: '12px',
                            textShadow: '0 0 2px rgba(0,0,0,0.5)',
                            pointerEvents: 'none',
                        }}
                    >
                        {watermarkText}
                    </div>
                ))}
            </div>

            {/* Center watermark - more visible */}
            <div 
                className="absolute inset-0 pointer-events-none z-[9999] flex items-center justify-center"
            >
                <div 
                    className="text-white/10 font-bold text-4xl transform rotate-[-15deg]"
                    style={{ textShadow: '0 0 10px rgba(0,0,0,0.3)' }}
                >
                    {watermarkText}
                </div>
            </div>
        </div>
    );
}
