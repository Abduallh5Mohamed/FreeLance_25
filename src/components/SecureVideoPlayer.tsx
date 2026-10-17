import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import Hls from 'hls.js';
import { Loader2, X, Play, Pause, Volume2, VolumeX, Shield, AlertTriangle, RotateCcw, RotateCw, Maximize, Minimize } from 'lucide-react';
import { VideoSecurityManager, SecurityViolation } from '@/utils/VideoSecurityManager';
import { notifySessionChange, subscribeSessionChange } from '@/lib/session-events';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

interface SecureVideoPlayerProps {
    videoId: string;
    offerId?: string;
    userId: string;
    studentName: string;
    groupName: string;
    onClose: () => void;
    directUrl?: string;
}

export function SecureVideoPlayer({
    videoId,
    offerId,
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
    const securityManagerRef = useRef<VideoSecurityManager | null>(null);

    const [loading, setLoading] = useState(true);
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
    const [hasStarted, setHasStarted] = useState(false);
    const [violationCount, setViolationCount] = useState(0);
    const [showWarning, setShowWarning] = useState(false);
    const [warningMessage, setWarningMessage] = useState('');
    const [consentRequired, setConsentRequired] = useState(false);
    const [consentTermsVersion, setConsentTermsVersion] = useState<string | null>(null);
    const [sessionRetry, setSessionRetry] = useState(0);
    const [sessionActive, setSessionActive] = useState(false);

    const sessionIdRef = useRef<string | null>(null);
    const sessionTokenRef = useRef<string | null>(null);
    const fingerprintRef = useRef<string | null>(null);
    const screenResRef = useRef<string | null>(null);

    const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const isLoggedOutRef = useRef(false);
    const animationFrameRef = useRef<number | null>(null);

    // Watermark tex
    const watermarkText = `${studentName} • ${groupName} • ${userId.slice(-4)}`;
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

    // Release the forced landscape orientation lock when the player is torn down.
    const unlockOrientation = useCallback(() => {
        try {
            if (screen.orientation && typeof screen.orientation.unlock === 'function') {
                screen.orientation.unlock();
            }
        } catch (e) {
            console.log('Orientation unlock failed:', e);
        }
    }, []);

    useEffect(() => unlockOrientation, [unlockOrientation]);

    // Same-document session teardown (supervisor/026): this component's
    // ownership is ONLY its token-clearing/logout event path — on any
    // same-document logout the protected video source is released (pause,
    // clear src, destroy HLS). Playback/protection behavior is untouched,
    // and the app-level logout owns navigation.
    useEffect(() => {
        const unsubscribe = subscribeSessionChange((event) => {
            if (event.kind !== 'logout') return;
            videoRef.current?.pause();
            if (videoRef.current) videoRef.current.src = '';
            hlsRef.current?.destroy();
        });
        return unsubscribe;
    }, []);

    // Keep the fullscreen state in sync with the browser (user can press Esc).
    useEffect(() => {
        const handleFullscreenChange = () => {
            const isNowFullscreen = Boolean(document.fullscreenElement);
            setIsFullscreen(isNowFullscreen);
            if (!isNowFullscreen) unlockOrientation();
        };
        document.addEventListener('fullscreenchange', handleFullscreenChange);
        return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
    }, [unlockOrientation]);

    // CANVAS WATERMARK RENDERER - STATIC (not animated)
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

        // STATIC grid watermarks
        ctx.save();
        ctx.globalAlpha = 0.15;
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 14px sans-serif';
        for (let x = 80; x < canvas.width; x += 250) {
            for (let y = 60; y < canvas.height; y += 120) {
                ctx.save();
                ctx.translate(x, y);
                ctx.rotate(-0.35);
                ctx.fillText(watermarkText, 0, 0);
                ctx.restore();
            }
        }
        ctx.restore();

        // Corner watermarks (static)
        const corners = [
            { x: 100, y: 30 },
            { x: canvas.width - 100, y: 30 },
            { x: 100, y: canvas.height - 50 },
            { x: canvas.width - 100, y: canvas.height - 50 }
        ];
        corners.forEach((corner) => {
            ctx.save();
            ctx.globalAlpha = 0.25;
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 12px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(watermarkText, corner.x, corner.y);
            ctx.restore();
        });

        // NO animation - render once only
    }, [watermarkText]);

    // FORCE LOGOUT
    const forceLogout = useCallback((reason: string) => {
        if (isLoggedOutRef.current) return;
        isLoggedOutRef.current = true;

        console.log('🚨 Force logout triggered:', reason);

        // Show black screen immediately
        setShowBlackScreen(true);
        setSecurityViolation(reason);

        // Pause video
        if (videoRef.current) {
            videoRef.current.pause();
            videoRef.current.src = '';
        }

        // Destroy HLS
        if (hlsRef.current) {
            hlsRef.current.destroy();
        }

        // Clear local storage
        localStorage.removeItem('authToken');
        localStorage.removeItem('auth_token');
        localStorage.removeItem('user_data');
        sessionStorage.clear();

        // The session mutation is complete: notify same-document subscribers.
        notifySessionChange('logout');

        // Navigate to auth after delay
        setTimeout(() => {
            navigate('/auth', { replace: true });
            window.location.reload();
        }, 2000);
    }, [navigate]);

    const acceptVideoSecurityTerms = async () => {
        const authToken = localStorage.getItem('authToken');
        if (!authToken || !consentTermsVersion) {
            setError('سجّل الدخول من جديد لقبول شروط حماية الفيديو.');
            return;
        }

        try {
            const response = await fetch(`${API_BASE}/secure-video/consent`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${authToken}`,
                },
                body: JSON.stringify({ accepted: true, termsVersion: consentTermsVersion }),
            });
            if (!response.ok) throw new Error('تعذر حفظ الموافقة. حاول مرة أخرى.');
            setConsentRequired(false);
            setError(null);
            setSessionRetry(value => value + 1);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'تعذر حفظ الموافقة. حاول مرة أخرى.');
        }
    };

    // SECURITY VIOLATION HANDLER
    const handleSecurityViolation = useCallback((violation: SecurityViolation) => {
        const isHosted = sourceType === 'hls' || sourceType === 'mp4';
        const isExternal = sourceType === 'youtube' || sourceType === 'drive';

        console.log('⚠️ Security violation detected:', violation);

        if (isHosted && hasStarted) {
            // For hosted videos: immediate action
            forceLogout(violation.details);
        } else if (isExternal) {
            // For external videos: blur and warn
            setViolationCount(prev => prev + 1);
            setWarningMessage(violation.details);
            setShowWarning(true);
            setIsSecurityBlurred(true);

            // Hide warning after 3 seconds
            setTimeout(() => {
                setShowWarning(false);
                setIsSecurityBlurred(false);
            }, 3000);

            // If too many violations, force logout anyway
            if (violationCount >= 3) {
                forceLogout('انتهاكات متعددة - Multiple Violations');
            }
        }
    }, [sourceType, hasStarted, violationCount, forceLogout]);

    const handleVisibilityHidden = useCallback(() => {
        videoRef.current?.pause();
        setIsPlaying(false);
    }, []);

    // INITIALIZE SECURITY MANAGER
    useEffect(() => {
        if (!hasStarted) return;

        const isHosted = sourceType === 'hls' || sourceType === 'mp4';

        securityManagerRef.current = new VideoSecurityManager({
            userId,
            videoId,
            studentName,
            isHostedVideo: isHosted,
            onViolation: handleSecurityViolation,
            onForceLogout: forceLogout,
            onVisibilityHidden: handleVisibilityHidden
        });

        // Start security after a brief grace period
        const graceTimeout = setTimeout(() => {
            securityManagerRef.current?.start();
        }, 2000);

        return () => {
            clearTimeout(graceTimeout);
            securityManagerRef.current?.stop();
        };
    }, [hasStarted, sourceType, userId, videoId, studentName, handleSecurityViolation, forceLogout, handleVisibilityHidden]);

    // RENDER STATIC WATERMARKS (and re-render on resize)
    useEffect(() => {
        renderWatermarks();

        const handleResize = () => renderWatermarks();
        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
        };
    }, [renderWatermarks]);

    // START SESSION - Force Fullscreen on Mobile
    const startSession = async () => {
        try {
            const container = containerRef.current;
            const video = videoRef.current;

            // Hide browser UI on mobile
            if (isMobile) {
                // Request fullscreen on container
                if (container) {
                    try {
                        if (container.requestFullscreen) {
                            await container.requestFullscreen();
                        } else if ((container as any).webkitRequestFullscreen) {
                            await (container as any).webkitRequestFullscreen();
                        } else if ((container as any).webkitEnterFullscreen) {
                            await (container as any).webkitEnterFullscreen();
                        }
                    } catch (e) {
                        console.log('Container fullscreen failed, trying video fullscreen');
                    }
                }

                // On iOS Safari, try video fullscreen as fallback
                if (video && (video as any).webkitEnterFullscreen) {
                    try {
                        await (video as any).webkitEnterFullscreen();
                    } catch (e) {
                        console.log('Video fullscreen also failed');
                    }
                }

                // Lock to landscape if possible
                try {
                    if (screen.orientation && (screen.orientation as any).lock) {
                        await (screen.orientation as any).lock('landscape').catch(() => {});
                    }
                } catch (e) {}
            } else {
                // Desktop fullscreen
                if (container) {
                    if (container.requestFullscreen) {
                        await container.requestFullscreen();
                    } else if ((container as any).webkitRequestFullscreen) {
                        await (container as any).webkitRequestFullscreen();
                    } else if ((container as any).msRequestFullscreen) {
                        await (container as any).msRequestFullscreen();
                    }
                }
            }

            // Play video
            if (video) {
                video.muted = false;
                await video.play();
            }

            setHasStarted(true);
            setIsFullscreen(true);
            setIsPlaying(true);
        } catch (err) {
            console.error('Session start error:', err);
            setHasStarted(true);
            // Try to play anyway
            if (videoRef.current) {
                videoRef.current.play().catch(() => {});
            }
        }
    };

    // PREPARE EXTERNAL URLS
    const getEmbedUrl = (url: string) => {
        if (url.includes('youtube.com') || url.includes('youtu.be')) {
            let id = '';
            if (url.includes('v=')) id = url.split('v=')[1]?.split('&')[0];
            else if (url.includes('youtu.be/')) id = url.split('youtu.be/')[1]?.split('?')[0];
            else if (url.includes('embed/')) id = url.split('embed/')[1]?.split('?')[0];

            if (id) return { type: 'youtube', url: `https://www.youtube.com/embed/${id}?autoplay=1&controls=1&modestbranding=1&rel=0` };
        }

        if (url.includes('drive.google.com')) {
            const cleanUrl = url.replace('/view', '/preview').replace('/edit', '/preview');
            return { type: 'drive', url: cleanUrl };
        }

        return { type: 'unknown', url };
    };

    // LOAD VIDEO
    useEffect(() => {
        setLoading(true);
        setError(null);
        setConsentRequired(false);
        setSessionActive(false);
        sessionIdRef.current = null;
        sessionTokenRef.current = null;

        const setupVideo = async () => {
            try {
                const isExternalUrl = Boolean(directUrl && /(?:youtube\.com|youtu\.be|drive\.google\.com)/i.test(directUrl));
                let finalUrl = isExternalUrl ? directUrl! : '';

                if (!isExternalUrl) {
                    const authToken = localStorage.getItem('authToken');
                    if (!authToken) throw new Error('سجّل الدخول لمشاهدة هذا الفيديو.');

                    const fingerprint = window.crypto.randomUUID();
                    const screenRes = `${window.screen.width}x${window.screen.height}`;
                    const response = await fetch(`${API_BASE}/secure-video/session`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${authToken}`,
                        },
                        body: JSON.stringify({ videoId, fingerprint, screenRes, ...(offerId ? { offerId } : {}) }),
                    });
                    const data = await response.json().catch(() => ({}));
                    if (response.status === 428 && data.code === 'VIDEO_CONSENT_REQUIRED') {
                        setConsentRequired(true);
                        setConsentTermsVersion(data.termsVersion || null);
                        setLoading(false);
                        return;
                    }
                    if (!response.ok) throw new Error(data.message || data.error || 'تعذر بدء جلسة الفيديو الآمنة.');

                    sessionIdRef.current = data.sessionId;
                    sessionTokenRef.current = data.sessionToken;
                    fingerprintRef.current = fingerprint;
                    screenResRef.current = screenRes;
                    setSessionActive(true);
                    finalUrl = data.streamUrl.startsWith('http') ? data.streamUrl : `${window.location.origin}${data.streamUrl}`;
                }

                // Determine type
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
                    if (videoRef.current && Hls.isSupported()) {
                        const hls = new Hls({
                            xhrSetup: (xhr) => {
                                const authToken = localStorage.getItem('authToken');
                                if (authToken) xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
                            }
                        });
                        hlsRef.current = hls;
                        hls.loadSource(finalUrl);
                        hls.attachMedia(videoRef.current);
                        hls.on(Hls.Events.MANIFEST_PARSED, () => {
                            setLoading(false);
                            // Auto-start on mobile
                            if (isMobile && videoRef.current) {
                                setHasStarted(true);
                                videoRef.current.play().catch(() => {});
                            }
                        });
                        hls.on(Hls.Events.ERROR, (_, data) => {
                            if (data.fatal) {
                                setError('فشل تحميل الفيديو');
                                setLoading(false);
                            }
                        });
                    } else if (videoRef.current?.canPlayType('application/vnd.apple.mpegurl')) {
                        videoRef.current.src = finalUrl;
                        setLoading(false);
                        // Auto-start on mobile for Safari
                        if (isMobile) {
                            setHasStarted(true);
                            videoRef.current.play().catch(() => {});
                        }
                    }
                } else {
                    setSourceType('mp4');
                    if (videoRef.current) {
                        videoRef.current.src = finalUrl;
                        setLoading(false);
                        // Auto-start on mobile
                        if (isMobile) {
                            setHasStarted(true);
                            videoRef.current.play().catch(() => {});
                        }
                    }
                }
            } catch (err: any) {
                setError(err.message);
                setLoading(false);
            }
        };

        setupVideo();

        return () => {
            sessionIdRef.current = null;
            sessionTokenRef.current = null;
            fingerprintRef.current = null;
            screenResRef.current = null;
            if (hlsRef.current) hlsRef.current.destroy();
            if (videoRef.current) {
                videoRef.current.pause();
                videoRef.current.src = '';
            }
        };
    }, [videoId, userId, directUrl, offerId, sessionRetry]);

    // Keep the server-side session alive and rotate the short-lived manifest token.
    useEffect(() => {
        if (!sessionActive) return;
        let heartbeatBusy = false;
        let refreshBusy = false;
        const authToken = localStorage.getItem('authToken');
        if (!authToken) {
            forceLogout('انتهت جلسة تسجيل الدخول');
            return;
        }

        const heartbeat = window.setInterval(async () => {
            if (heartbeatBusy || !sessionIdRef.current || !sessionTokenRef.current) return;
            heartbeatBusy = true;
            try {
                const response = await fetch(`${API_BASE}/secure-video/heartbeat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
                    body: JSON.stringify({ sessionId: sessionIdRef.current, sessionToken: sessionTokenRef.current }),
                });
                if (!response.ok) forceLogout('انتهت جلسة الفيديو الآمنة');
            } catch {
                // Fail closed: the server ends sessions that miss their heartbeat window.
                forceLogout('تعذر التحقق من جلسة الفيديو الآمنة');
            } finally {
                heartbeatBusy = false;
            }
        }, 5000);

        const refresh = window.setInterval(async () => {
            if (refreshBusy || !sessionIdRef.current || !fingerprintRef.current || !screenResRef.current) return;
            refreshBusy = true;
            try {
                const response = await fetch(`${API_BASE}/secure-video/refresh-token`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
                    body: JSON.stringify({
                        sessionId: sessionIdRef.current,
                        fingerprint: fingerprintRef.current,
                        screenRes: screenResRef.current,
                    }),
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok || !data.sessionToken) {
                    forceLogout('تعذر تجديد جلسة الفيديو الآمنة');
                    return;
                }
                sessionTokenRef.current = data.sessionToken;
                if (data.streamUrl) {
                    const streamUrl = data.streamUrl.startsWith('http')
                        ? data.streamUrl
                        : `${window.location.origin}${data.streamUrl}`;
                    const video = videoRef.current;
                    const hls = hlsRef.current;
                    const resumeAt = video?.currentTime || 0;
                    const shouldResume = Boolean(video && !video.paused);
                    if (hls) {
                        const onManifest = () => {
                            hls.off(Hls.Events.MANIFEST_PARSED, onManifest);
                            if (video && resumeAt > 0) video.currentTime = resumeAt;
                            if (shouldResume) video?.play().catch(() => undefined);
                        };
                        hls.on(Hls.Events.MANIFEST_PARSED, onManifest);
                        hls.loadSource(streamUrl);
                    } else if (video) {
                        video.src = streamUrl;
                        video.addEventListener('loadedmetadata', () => {
                            if (resumeAt > 0) video.currentTime = resumeAt;
                            if (shouldResume) video.play().catch(() => undefined);
                        }, { once: true });
                    }
                }
            } catch {
                forceLogout('تعذر تجديد جلسة الفيديو الآمنة');
            } finally {
                refreshBusy = false;
            }
        }, 40000);

        return () => {
            window.clearInterval(heartbeat);
            window.clearInterval(refresh);
        };
    }, [sessionActive, forceLogout]);

    // VIDEO CONTROLS
    const togglePlay = useCallback(() => {
        if (videoRef.current) {
            if (isPlaying) {
                videoRef.current.pause();
            } else {
                videoRef.current.play();
            }
        }
    }, [isPlaying]);

    const toggleMute = useCallback(() => {
        if (videoRef.current) {
            videoRef.current.muted = !videoRef.current.muted;
            setIsMuted(!isMuted);
        }
    }, [isMuted]);

    // Fullscreen is only requested from a user gesture (button or 'f' key).
    const toggleFullscreen = useCallback(async () => {
        const container = containerRef.current;
        if (!container) return;
        try {
            if (document.fullscreenElement) {
                await document.exitFullscreen();
            } else if (container.requestFullscreen) {
                await container.requestFullscreen();
            } else if ((container as any).webkitRequestFullscreen) {
                await (container as any).webkitRequestFullscreen();
            } else if ((container as any).msRequestFullscreen) {
                await (container as any).msRequestFullscreen();
            }
        } catch (e) {
            console.log('Fullscreen toggle failed:', e);
        }
    }, []);

    // SKIP FORWARD/BACKWARD
    const skip = useCallback((seconds: number) => {
        if (videoRef.current) {
            videoRef.current.currentTime = Math.max(0, Math.min(duration, videoRef.current.currentTime + seconds));
        }
    }, [duration]);

    // Keyboard controls for the secure player (plain keys only; modifier
    // combinations are reserved for the security supervisor's blocking rules).
    useEffect(() => {
        if (!hasStarted) return;
        if (sourceType !== 'hls' && sourceType !== 'mp4') return;

        const isTypingTarget = (target: EventTarget | null): boolean => {
            if (!(target instanceof HTMLElement)) return false;
            return target.tagName === 'INPUT'
                || target.tagName === 'TEXTAREA'
                || target.tagName === 'SELECT'
                || target.isContentEditable
                // The seek slider handles its own arrow keys; global
                // shortcuts must not double-seek while it is focused.
                || target.getAttribute('role') === 'slider';
        };

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            if (isTypingTarget(e.target)) return;

            switch (e.key) {
                case ' ':
                case 'k':
                    e.preventDefault();
                    togglePlay();
                    break;
                case 'ArrowLeft':
                case 'j':
                    e.preventDefault();
                    skip(-5);
                    break;
                case 'ArrowRight':
                case 'l':
                    e.preventDefault();
                    skip(5);
                    break;
                case 'm':
                    e.preventDefault();
                    toggleMute();
                    break;
                case 'f':
                    e.preventDefault();
                    void toggleFullscreen();
                    break;
                default:
                    break;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [hasStarted, sourceType, togglePlay, skip, toggleMute, toggleFullscreen]);

    // SEEK TO POSITION (pointer)
    const seekTo = (e: React.MouseEvent<HTMLDivElement>) => {
        if (videoRef.current && duration) {
            const rect = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const percentage = x / rect.width;
            videoRef.current.currentTime = percentage * duration;
        }
    };

    // SEEK WITH KEYBOARD on the scrubber. The scrubber is an interactive
    // slider (role="slider"), so it owns its own arrow/Home/End/Page keys;
    // the global player shortcuts must not double-seek while it is focused.
    const handleScrubberKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const video = videoRef.current;
        if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;

        switch (e.key) {
            case 'ArrowRight':
            case 'ArrowUp':
                e.preventDefault();
                video.currentTime = Math.min(video.duration, video.currentTime + 5);
                break;
            case 'ArrowLeft':
            case 'ArrowDown':
                e.preventDefault();
                video.currentTime = Math.max(0, video.currentTime - 5);
                break;
            case 'PageUp':
                e.preventDefault();
                video.currentTime = Math.min(video.duration, video.currentTime + 30);
                break;
            case 'PageDown':
                e.preventDefault();
                video.currentTime = Math.max(0, video.currentTime - 30);
                break;
            case 'Home':
                e.preventDefault();
                video.currentTime = 0;
                break;
            case 'End':
                e.preventDefault();
                video.currentTime = video.duration;
                break;
            default:
                break;
        }
    };

    // FORMAT TIME
    const formatTime = (time: number) => {
        if (!time || !isFinite(time)) return '0:00';
        const mins = Math.floor(time / 60);
        const secs = Math.floor(time % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    const handleClose = () => {
        securityManagerRef.current?.stop();
        if (hlsRef.current) hlsRef.current.destroy();
        unlockOrientation();
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
        }
        onClose();
    };

    // TIME UPDATE
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const handleTimeUpdate = () => {
            setCurrentTime(video.currentTime);
            setProgress((video.currentTime / video.duration) * 100);
        };

        const handleDurationChange = () => {
            setDuration(video.duration);
        };

        const handlePlay = () => setIsPlaying(true);
        const handlePause = () => setIsPlaying(false);

        video.addEventListener('timeupdate', handleTimeUpdate);
        video.addEventListener('durationchange', handleDurationChange);
        video.addEventListener('play', handlePlay);
        video.addEventListener('pause', handlePause);

        return () => {
            video.removeEventListener('timeupdate', handleTimeUpdate);
            video.removeEventListener('durationchange', handleDurationChange);
            video.removeEventListener('play', handlePlay);
            video.removeEventListener('pause', handlePause);
        };
    }, []);

    // RENDER
    return (
        <div
            ref={containerRef}
            className="fixed inset-0 z-[9999] bg-black flex items-center justify-center select-none overflow-hidden"
            style={{
                userSelect: 'none',
                WebkitUserSelect: 'none',
                width: '100vw',
                height: '100dvh',
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0
            }}
        >
            {/* BLACK SCREEN ON VIOLATION */}
            {showBlackScreen && (
                <div className="absolute inset-0 z-[10001] bg-black flex flex-col items-center justify-center text-white animate-pulse">
                    <Shield className="w-32 h-32 text-red-600 mb-6" />
                    <h2 className="text-3xl font-bold mb-4 text-red-500">🚨 تم اكتشاف انتهاك أمني!</h2>
                    <p className="text-xl text-gray-400 mb-2">Security Violation Detected</p>
                    <p className="text-lg text-gray-500">{securityViolation}</p>
                    <p className="text-sm text-gray-600 mt-8">جاري تسجيل الخروج...</p>
                </div>
            )}

            {/* WARNING TOAST FOR EXTERNAL VIDEOS */}
            {showWarning && (
                <div className="absolute top-8 left-1/2 -translate-x-1/2 z-[10000] bg-yellow-600/90 text-white px-6 py-4 rounded-lg shadow-2xl flex items-center gap-3 animate-bounce">
                    <AlertTriangle className="w-6 h-6" />
                    <div>
                        <p className="font-bold">تحذير أمني!</p>
                        <p className="text-sm">{warningMessage}</p>
                        <p className="text-xs mt-1">({violationCount}/3 تحذيرات)</p>
                    </div>
                </div>
            )}

            {/* SECURITY BLUR OVERLAY */}
            {isSecurityBlurred && !showBlackScreen && (
                <div className="absolute inset-0 z-[9998] backdrop-blur-xl bg-black/50" />
            )}

            {consentRequired && (
                <div className="absolute inset-0 z-[10000] bg-black/95 flex flex-col items-center justify-center gap-5 p-6 text-center text-white">
                    <Shield className="h-16 w-16 text-blue-400" />
                    <h2 className="text-2xl font-bold">شروط حماية الفيديو</h2>
                    <p className="max-w-xl text-gray-300">بالموافقة، ستبدأ جلسة مشاهدة آمنة وتُسجّل موافقتك على شروط حماية الفيديو لهذه النسخة.</p>
                    <button onClick={acceptVideoSecurityTerms} className="rounded-lg bg-blue-600 px-6 py-3 font-bold hover:bg-blue-700">
                        أوافق وأتابع
                    </button>
                    <button onClick={handleClose} className="text-gray-400 underline">إلغاء</button>
                </div>
            )}

            {/* START SESSION OVERLAY - Skip on Mobile, show on Desktop */}
            {!hasStarted && !loading && (sourceType === 'hls' || sourceType === 'mp4') && !isMobile && (
                <div
                    className="absolute inset-0 z-[9000] bg-black/95 flex flex-col items-center justify-center text-white cursor-pointer"
                    onClick={startSession}
                >
                    {isMobile ? (
                        <div className="flex flex-col items-center">
                            <div className="w-24 h-24 bg-blue-600 rounded-full flex items-center justify-center shadow-lg shadow-blue-500/50 mb-6 animate-pulse">
                                <Play className="w-10 h-10 fill-white text-white ml-1" />
                            </div>
                            <p className="text-gray-400 text-lg">اضغط للتشغيل الآمن</p>
                            <p className="text-gray-600 text-sm mt-2">سيتم تفعيل الحماية تلقائياً</p>
                        </div>
                    ) : (
                        <>
                            <Shield className="w-24 h-24 text-blue-500 mb-8" />
                            <h2 className="text-3xl font-bold mb-4">🔒 جلسة مشاهدة آمنة</h2>
                            <div className="bg-gray-900/50 p-6 rounded-lg max-w-lg mb-8 border border-gray-700">
                                <h3 className="text-yellow-500 font-bold mb-3 flex items-center gap-2">
                                    <AlertTriangle className="w-5 h-5" />
                                    تحذير أمني هام
                                </h3>
                                <ul className="text-gray-400 space-y-2 text-sm">
                                    <li>• عند البدء، سيتم تفعيل وضع الحماية القصوى</li>
                                    <li>• محاولة التقاط صورة للشاشة = تسجيل خروج فوري</li>
                                    <li>• محاولة تسجيل الشاشة = تسجيل خروج فوري</li>
                                    <li>• التبديل بين النوافذ = تسجيل خروج فوري</li>
                                    <li>• فتح أدوات المطورين = تسجيل خروج فوري</li>
                                </ul>
                            </div>
                            <button
                                onClick={(e) => { e.stopPropagation(); startSession(); }}
                                className="px-10 py-4 bg-blue-600 hover:bg-blue-700 rounded-full text-xl font-bold transition-all shadow-lg hover:shadow-blue-500/30 flex items-center gap-3"
                            >
                                <Shield className="w-6 h-6" />
                                بدء المشاهدة الآمنة
                            </button>
                            <button onClick={handleClose} className="mt-6 text-gray-500 hover:text-white underline">
                                إلغاء
                            </button>
                        </>
                    )}
                </div>
            )}

            {/* VIDEO CONTENT */}
            {sourceType === 'youtube' || sourceType === 'drive' ? (
                <iframe
                    src={embedUrl}
                    title="مشغل الفيديو"
                    className={`${isSecurityBlurred ? 'blur-xl' : ''}`}
                    allow="autoplay; encrypted-media; fullscreen"
                    allowFullScreen
                    style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: '100%',
                        border: 'none',
                        objectFit: 'contain'
                    }}
                />
            ) : (
                <video
                    ref={videoRef}
                    className={`${!hasStarted ? 'blur-lg' : ''} ${isSecurityBlurred ? 'blur-xl' : ''}`}
                    playsInline
                    disablePictureInPicture
                    controlsList="nodownload nofullscreen noremoteplayback"
                    onContextMenu={(e) => e.preventDefault()}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: '100%',
                        objectFit: 'contain',
                        backgroundColor: '#000'
                    }}
                />
            )}

            {/* CANVAS WATERMARK */}
            <canvas
                ref={canvasRef}
                className="absolute inset-0 pointer-events-none z-[50]"
            />

            {/* CONTROLS FOR HOSTED VIDEOS */}
            {(sourceType === 'hls' || sourceType === 'mp4') && hasStarted && !loading && !error && !showBlackScreen && (
                <div
                    className="absolute inset-0 z-[60] flex flex-col justify-between"
                    onClick={togglePlay}
                >
                    {/* TOP BAR */}
                    <div className="flex justify-between items-center p-4 bg-gradient-to-b from-black/70 to-transparent">
                        <button
                            onClick={(e) => { e.stopPropagation(); handleClose(); }}
                            aria-label="إغلاق المشغل"
                            title="إغلاق المشغل"
                            className="p-2 bg-red-600/80 rounded-full hover:bg-red-600 text-white transition-colors"
                        >
                            <X className="w-5 h-5" />
                        </button>
                        <div className="flex items-center gap-2 text-green-500 text-xs">
                            <Shield className="w-3 h-3" />
                            <span>حماية نشطة</span>
                        </div>
                    </div>

                    {/* CENTER CONTROLS */}
                    <div className="flex justify-center items-center gap-8" onClick={(e) => e.stopPropagation()}>
                        {/* -5 SECONDS */}
                        <button
                            onClick={() => skip(-5)}
                            aria-label="ترجيع 5 ثوانٍ"
                            title="ترجيع 5 ثوانٍ"
                            className="p-3 bg-white/20 rounded-full hover:bg-white/30 text-white transition-colors flex flex-col items-center"
                        >
                            <RotateCcw className="w-7 h-7" />
                            <span className="text-xs mt-1">-5</span>
                        </button>

                        {/* PLAY/PAUSE */}
                        <button
                            onClick={togglePlay}
                            aria-label={isPlaying ? 'إيقاف مؤقت' : 'تشغيل'}
                            title={isPlaying ? 'إيقاف مؤقت' : 'تشغيل'}
                            className="p-5 bg-white/25 rounded-full hover:bg-white/35 text-white transition-colors"
                        >
                            {isPlaying ? <Pause className="w-10 h-10" /> : <Play className="w-10 h-10 fill-white" />}
                        </button>

                        {/* +5 SECONDS */}
                        <button
                            onClick={() => skip(5)}
                            aria-label="تقديم 5 ثوانٍ"
                            title="تقديم 5 ثوانٍ"
                            className="p-3 bg-white/20 rounded-full hover:bg-white/30 text-white transition-colors flex flex-col items-center"
                        >
                            <RotateCw className="w-7 h-7" />
                            <span className="text-xs mt-1">+5</span>
                        </button>
                    </div>

                    {/* BOTTOM BAR - PROGRESS + CONTROLS */}
                    <div className="bg-gradient-to-t from-black/80 to-transparent p-4" onClick={(e) => e.stopPropagation()}>
                        {/* PROGRESS / SEEK SLIDER — interactive seek is a
                            keyboard-operable slider, not just a progressbar */}
                        <div
                            className="w-full h-2 bg-white/30 rounded-full cursor-pointer mb-3 relative group"
                            onClick={seekTo}
                            onKeyDown={handleScrubberKeyDown}
                            role="slider"
                            tabIndex={0}
                            aria-label="شريط تقدم الفيديو"
                            aria-valuemin={0}
                            aria-valuemax={Number.isFinite(duration) ? Math.max(0, Math.round(duration)) : 0}
                            aria-valuenow={Number.isFinite(currentTime) ? Math.max(0, Math.round(currentTime)) : 0}
                            aria-valuetext={`${formatTime(currentTime)} / ${formatTime(duration)}`}
                        >
                            <div
                                className="h-full bg-blue-500 rounded-full relative"
                                style={{ width: `${progress}%` }}
                            >
                                <div className="absolute right-0 top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full shadow-lg opacity-0 group-hover:opacity-100 transition-opacity" />
                            </div>
                        </div>

                        {/* TIME + VOLUME + FULLSCREEN */}
                        <div className="flex justify-between items-center text-white text-sm">
                            <span className="font-mono">{formatTime(currentTime)} / {formatTime(duration)}</span>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={toggleMute}
                                    aria-label={isMuted ? 'إلغاء كتم الصوت' : 'كتم الصوت'}
                                    title={isMuted ? 'إلغاء كتم الصوت' : 'كتم الصوت'}
                                    className="p-2 bg-white/10 rounded-full hover:bg-white/20"
                                >
                                    {isMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                                </button>
                                <button
                                    onClick={() => void toggleFullscreen()}
                                    aria-label={isFullscreen ? 'إنهاء ملء الشاشة' : 'ملء الشاشة'}
                                    title={isFullscreen ? 'إنهاء ملء الشاشة' : 'ملء الشاشة'}
                                    className="p-2 bg-white/10 rounded-full hover:bg-white/20"
                                >
                                    {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* CLOSE BUTTON FOR EXTERNAL */}
            {(sourceType === 'youtube' || sourceType === 'drive') && (
                <button
                    onClick={handleClose}
                    aria-label="إغلاق المشغل"
                    title="إغلاق المشغل"
                    className="absolute top-6 left-6 z-[70] p-3 bg-red-600 rounded-full hover:bg-red-700 text-white shadow-lg"
                >
                    <X className="w-6 h-6" />
                </button>
            )}

            {/* LOADING */}
            {loading && (
                <div className="absolute inset-0 flex items-center justify-center bg-black z-[80]">
                    <div className="flex flex-col items-center">
                        <Loader2 className="w-16 h-16 text-blue-500 animate-spin mb-4" />
                        <p className="text-white">جاري تحميل الفيديو...</p>
                    </div>
                </div>
            )}

            {/* ERROR */}
            {error && !loading && (
                <div className="absolute inset-0 flex items-center justify-center bg-black z-[80]">
                    <div className="flex flex-col items-center text-center">
                        <AlertTriangle className="w-16 h-16 text-red-500 mb-4" />
                        <p className="text-white text-xl mb-2">حدث خطأ</p>
                        <p className="text-gray-400">{error}</p>
                        <button onClick={handleClose} className="mt-6 px-6 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg">
                            إغلاق
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

export default SecureVideoPlayer;
