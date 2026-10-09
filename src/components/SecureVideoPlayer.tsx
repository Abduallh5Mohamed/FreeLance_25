/**
 * SecureVideoPlayer v4.0 — Production Anti-Piracy Video Player
 *
 * Architecture:
 * - JWT-bound session with 2-min short-lived tokens
 * - Server-seeded forensic watermarks
 * - SecuritySupervisor hook for continuous monitoring
 * - Heartbeat every 5s, token refresh every 90s
 * - Violation scoring → session kill → account suspension
 * - Multi-layer transparent overlays
 * - Canvas watermark with frame-level noise
 * - All screen capture APIs overridden
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import Hls from 'hls.js';
import { Loader2, X, ShieldAlert, Shield, Lock, Play, Pause, Volume2, VolumeX, Maximize, Minimize, RotateCcw, RotateCw } from 'lucide-react';
import { useSecuritySupervisor } from '@/hooks/useSecuritySupervisor';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

interface SecureVideoPlayerProps {
    videoId: string;
    userId: string;
    studentName: string;
    groupName: string;
    onClose: () => void;
    directUrl?: string;
    offerId?: string;
}

interface WatermarkData {
    seed: string;
    studentName: string;
    studentPhone: string;
    groupName: string;
    userId: string;
    forensicCode?: string;
}

interface VideoRestrictions {
    qualityCap: number | null;
    fullscreenAllowed: boolean;
    riskScore: number;
}

// ═══════════════════════════════════════
// DEVICE FINGERPRINT
// ═══════════════════════════════════════
function generateFingerprint(): string {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (ctx) {
        ctx.textBaseline = 'top';
        ctx.font = '14px Arial';
        ctx.fillText('fingerprint', 2, 2);
    }
    const canvasData = canvas.toDataURL();

    const components = [
        navigator.userAgent,
        navigator.language,
        screen.width + 'x' + screen.height,
        screen.colorDepth,
        new Date().getTimezoneOffset(),
        navigator.hardwareConcurrency || 0,
        canvasData.substring(0, 50),
    ];

    let hash = 0;
    const str = components.join('|');
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
}

export function SecureVideoPlayer({
    videoId,
    userId,
    studentName,
    groupName,
    onClose,
    directUrl,
    offerId
}: SecureVideoPlayerProps) {
    const navigate = useNavigate();
    const videoRef = useRef<HTMLVideoElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const hlsRef = useRef<Hls | null>(null);
    const animationFrameRef = useRef<number | null>(null);

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [sourceType, setSourceType] = useState<'hls' | 'mp4' | 'youtube' | 'drive' | 'vdocipher' | 'unknown'>('unknown');
    const [embedUrl, setEmbedUrl] = useState('');
    const [showControls, setShowControls] = useState(true);
    const [volume, setVolume] = useState(1);
    const [isMuted, setIsMuted] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [progress, setProgress] = useState(0);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const progressBarRef = useRef<HTMLDivElement>(null);

    // Security session state
    const [sessionId, setSessionId] = useState('');
    const [sessionToken, setSessionToken] = useState('');
    const sessionTokenRef = useRef('');
    const deviceFingerprintRef = useRef(generateFingerprint());
    const screenResolutionRef = useRef(`${screen.width}x${screen.height}`);
    const [watermarkData, setWatermarkData] = useState<WatermarkData | null>(null);
    const [sessionReady, setSessionReady] = useState(false);
    const [securityViolation, setSecurityViolation] = useState<string | null>(null);
    const [suspensionInfo, setSuspensionInfo] = useState<{ until: string; reason: string } | null>(null);
    const [consentRequired, setConsentRequired] = useState(false);
    const [consentChecked, setConsentChecked] = useState(false);
    const [consentAccepted, setConsentAccepted] = useState(false);
    const [consentBusy, setConsentBusy] = useState(false);
    const [termsVersion, setTermsVersion] = useState('video-security-v1');
    const [consentRevision, setConsentRevision] = useState(0);
    const [serverRestrictions, setServerRestrictions] = useState<VideoRestrictions>({ qualityCap: null, fullscreenAllowed: true, riskScore: 0 });

    // ═══════════════════════════════════════
    // SECURITY SUPERVISOR HOOK
    // ═══════════════════════════════════════
    const {
        isBlocked,
        blockScreen,
        unblockScreen,
        forceLogout,
        reportViolation,
        restrictions: liveRestrictions
    } = useSecuritySupervisor({
        sessionId,
        sessionToken,
        videoId,
        userId,
        containerRef: containerRef as React.RefObject<HTMLElement>,
        videoRef,
        onViolation: (type, details) => {
            console.log(`🛡️ Violation: ${type} - ${details}`);
        },
        onSessionKilled: () => {
            setSecurityViolation('تم إنهاء الجلسة بسبب نشاط مشبوه');
        }
    });

    // ═══════════════════════════════════════
    // SESSION INITIALIZATION
    // ═══════════════════════════════════════
    useEffect(() => {
        const initSession = async () => {
            // External providers cannot use the platform's encrypted session.
            if (directUrl && (directUrl.includes('youtube') || directUrl.includes('youtu.be') || directUrl.includes('drive.google.com'))) {
                setError('روابط الفيديو الخارجية ممنوعة. يجب إعادة رفع الفيديو على المنصة لمعالجته وتشفيره.');
                setSessionReady(true);
                setLoading(false);
                return;
            }

            try {
                const token = localStorage.getItem('authToken');
                const consentResp = await fetch(`${API_BASE}/secure-video/consent`, {
                    headers: { 'Authorization': `Bearer ${token || ''}` },
                });
                if (consentResp.ok) {
                    const consent = await consentResp.json();
                    setTermsVersion(consent.termsVersion || 'video-security-v1');
                    setConsentChecked(true);
                    if (consent.required) {
                        setConsentRequired(true);
                        setLoading(false);
                        return;
                    }
                }
                const fingerprint = deviceFingerprintRef.current;
                const screenRes = screenResolutionRef.current;

                const resp = await fetch(`${API_BASE}/secure-video/session`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({ videoId, fingerprint, screenRes, offerId })
                });

                if (!resp.ok) {
                    const errData = await resp.json().catch(() => ({}));
                    if (errData.error === 'account_suspended') {
                        setSuspensionInfo({
                            until: errData.until,
                            reason: errData.message
                        });
                        setLoading(false);
                        return;
                    }
                    if (errData.code === 'VIDEO_CONSENT_REQUIRED') {
                        setTermsVersion(errData.termsVersion || 'video-security-v1');
                        setConsentChecked(true);
                        setConsentRequired(true);
                        setLoading(false);
                        return;
                    }
                    throw new Error(errData.error || 'Failed to create session');
                }

                const data = await resp.json();
                setSessionId(data.sessionId);
                setSessionToken(data.sessionToken);
                sessionTokenRef.current = data.sessionToken;
                setWatermarkData(data.watermark);
                if (data.restrictions) setServerRestrictions(data.restrictions);
                setSessionReady(true);

                if (data.provider === 'vdocipher' && data.playerUrl) {
                    setSourceType('vdocipher');
                    setEmbedUrl(data.playerUrl);
                    setLoading(false);
                    return;
                }

                // Load the video with the session's stream URL
                await loadVideo(data.streamUrl, data.sessionId, data.sessionToken);

            } catch (err: unknown) {
                console.error('[SecureVideo] Session init failed:', err);
                setSessionReady(false);
                setLoading(false);
                setError(err instanceof Error ? err.message : 'تعذر إنشاء جلسة فيديو آمنة');
            }
        };

        initSession();

        return () => {
            if (hlsRef.current) hlsRef.current.destroy();
            if (videoRef.current) {
                videoRef.current.pause();
                videoRef.current.src = '';
                videoRef.current.load();
            }
        };
    }, [videoId, userId, directUrl, offerId, consentRevision]);

    const acceptVideoTerms = async () => {
        if (!consentAccepted || consentBusy) return;
        setConsentBusy(true);
        try {
            const response = await fetch(`${API_BASE}/secure-video/consent`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('authToken') || ''}` },
                body: JSON.stringify({ accepted: true, termsVersion }),
            });
            if (!response.ok) throw new Error('تعذر حفظ الموافقة');
            setConsentRequired(false);
            setLoading(true);
            setConsentRevision(value => value + 1);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'تعذر حفظ الموافقة');
        } finally {
            setConsentBusy(false);
        }
    };

    // Kill session on unmount
    useEffect(() => {
        return () => {
            if (sessionId) {
                fetch(`${API_BASE}/secure-video/kill-session`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${localStorage.getItem('authToken') || ''}`,
                    },
                    body: JSON.stringify({ sessionId, sessionToken, reason: 'player_closed' })
                }).catch(() => { });
            }
        };
    }, [sessionId, sessionToken]);

    useEffect(() => {
        if (!sessionId) return;
        const refresh = window.setInterval(async () => {
            try {
                const response = await fetch(`${API_BASE}/secure-video/refresh-token`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('authToken') || ''}` },
                    body: JSON.stringify({ sessionId, fingerprint: deviceFingerprintRef.current, screenRes: screenResolutionRef.current }),
                });
                if (!response.ok) return;
                const data = await response.json();
                sessionTokenRef.current = data.sessionToken;
                setSessionToken(data.sessionToken);
                if (data.restrictions) setServerRestrictions(data.restrictions);
                if (!hlsRef.current && data.streamUrl && videoRef.current?.canPlayType('application/vnd.apple.mpegurl')) {
                    const video = videoRef.current;
                    const position = video.currentTime;
                    const shouldResume = !video.paused;
                    video.src = data.streamUrl;
                    video.addEventListener('loadedmetadata', () => {
                        if (Number.isFinite(position)) video.currentTime = position;
                        if (shouldResume) video.play().catch(() => { });
                    }, { once: true });
                }
            } catch { /* heartbeat will terminate a genuinely invalid session */ }
        }, 40_000);
        return () => window.clearInterval(refresh);
    }, [sessionId]);

    // ═══════════════════════════════════════
    // VIDEO LOADING
    // ═══════════════════════════════════════

    const handleExternalUrl = (url: string) => {
        if (url.includes('youtube') || url.includes('youtu.be')) {
            let id = '';
            if (url.includes('v=')) id = url.split('v=')[1]?.split('&')[0];
            else if (url.includes('youtu.be/')) id = url.split('youtu.be/')[1]?.split('?')[0];
            else if (url.includes('embed/')) id = url.split('embed/')[1]?.split('?')[0];
            if (id) {
                setSourceType('youtube');
                setEmbedUrl(`https://www.youtube.com/embed/${id}?autoplay=1&controls=1&modestbranding=1&rel=0`);
            }
        } else if (url.includes('drive.google.com')) {
            setSourceType('drive');
            setEmbedUrl(url.replace('/view', '/preview').replace('/edit', '/preview'));
        }
        setLoading(false);
    };

    const loadVideo = async (streamUrl: string, sid: string, sToken: string) => {
        try {
            setLoading(true);

            if (streamUrl.includes('.m3u8')) {
                setSourceType('hls');
                if (videoRef.current && Hls.isSupported()) {
                    const hls = new Hls({
                        xhrSetup: (xhr, url) => {
                            if (url.includes('/secure-video/')) {
                                const secured = new URL(url, window.location.origin);
                                secured.searchParams.set('token', sessionTokenRef.current || sToken);
                                secured.searchParams.set('sid', sid);
                                xhr.open('GET', secured.toString(), true);
                                xhr.setRequestHeader('X-Video-Fingerprint', deviceFingerprintRef.current);
                                xhr.setRequestHeader('X-Screen-Resolution', screenResolutionRef.current);
                            }
                        }
                    });
                    if (serverRestrictions.qualityCap !== null) hls.autoLevelCapping = serverRestrictions.qualityCap;
                    hlsRef.current = hls;
                    hls.loadSource(streamUrl);
                    hls.attachMedia(videoRef.current);
                    hls.on(Hls.Events.MANIFEST_PARSED, () => {
                        setLoading(false);
                        videoRef.current?.play().catch(() => { });
                    });
                    hls.on(Hls.Events.ERROR, (_, data) => {
                        if (data.fatal) {
                            setError('فشل تحميل الفيديو');
                            setLoading(false);
                        }
                    });
                } else if (videoRef.current?.canPlayType('application/vnd.apple.mpegurl')) {
                    videoRef.current.src = streamUrl;
                    videoRef.current.addEventListener('loadedmetadata', () => {
                        setLoading(false);
                        videoRef.current?.play().catch(() => { });
                    }, { once: true });
                } else {
                    setError('المتصفح لا يدعم تشغيل HLS الآمن');
                    setLoading(false);
                }
            } else {
                setSourceType('mp4');
                if (videoRef.current) {
                    videoRef.current.src = streamUrl;
                    videoRef.current.play().catch(() => { });
                    setLoading(false);
                }
            }
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Failed to load video');
            setLoading(false);
        }
    };

    // Legacy fallback
    const loadVideoLegacy = async () => {
        try {
            setLoading(true);
            let finalUrl = directUrl || '';

            if (!directUrl) {
                const response = await fetch(`${API_BASE}/videos/stream/${videoId}?userId=${userId}`, {
                    headers: {
                        'Authorization': `Bearer ${localStorage.getItem('authToken') || ''}`,
                    },
                });
                if (!response.ok) throw new Error('Failed to load video');
                const data = await response.json();
                finalUrl = data.streamUrl.startsWith('http') ? data.streamUrl : `${window.location.origin}${data.streamUrl}`;
            }

            if (finalUrl.includes('youtube') || finalUrl.includes('youtu.be') || finalUrl.includes('drive.google.com')) {
                handleExternalUrl(finalUrl);
                return;
            }

            if (finalUrl.includes('.m3u8')) {
                setSourceType('hls');
                if (videoRef.current && Hls.isSupported()) {
                    const hls = new Hls({
                        xhrSetup: (xhr, url) => {
                            if (url.includes('/key/')) {
                                xhr.setRequestHeader('Authorization', `Bearer ${localStorage.getItem('authToken') || ''}`);
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
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Failed to load video');
            setLoading(false);
        }
    };

    // ═══════════════════════════════════════
    // FORENSIC WATERMARK RENDERER
    // ═══════════════════════════════════════
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

        const wm = watermarkData;
        const time = Date.now() / 2000;
        const seed = wm?.seed || 'default';

        // Seeded random function
        const seededRandom = (i: number) => {
            const x = Math.sin(i * 12.9898 + seed.charCodeAt(i % seed.length) * 78.233) * 43758.5453;
            return x - Math.floor(x);
        };

        const wmText = wm
            ? `${wm.studentName} • ${wm.groupName} • ${wm.userId} • ${wm.studentPhone}`
            : `${studentName} • ${groupName} • ${userId.slice(-4)}`;

        const timestamp = new Date().toLocaleTimeString('ar-EG');

        // Moving watermarks
        const count = 15;
        for (let i = 0; i < count; i++) {
            const baseX = seededRandom(i * 3) * canvas.width;
            const baseY = seededRandom(i * 3 + 1) * canvas.height;
            const x = baseX + Math.sin(time + i * 0.7) * 40;
            const y = baseY + Math.cos(time * 0.8 + i * 1.3) * 30;

            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(-0.4 + seededRandom(i * 5) * 0.3);
            ctx.globalAlpha = 0.18 + Math.sin(time * 1.5 + i) * 0.08;
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 16px sans-serif';
            ctx.fillText(wmText, 0, 0);
            ctx.restore();
        }

        // Timestamp watermarks
        for (let i = 0; i < 3; i++) {
            const tx = seededRandom(i + 100) * canvas.width * 0.8 + canvas.width * 0.1;
            const ty = seededRandom(i + 200) * canvas.height * 0.8 + canvas.height * 0.1;
            ctx.save();
            ctx.translate(tx, ty);
            ctx.rotate(-0.3);
            ctx.globalAlpha = 0.12;
            ctx.fillStyle = '#ffffff';
            ctx.font = '12px monospace';
            ctx.fillText(`${timestamp} | ${wmText}`, 0, 0);
            ctx.restore();
        }

        // Center watermark
        ctx.save();
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(-0.5);
        ctx.globalAlpha = 0.12;
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 36px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(wmText, 0, 0);
        ctx.restore();

        // Frame-level noise
        const noiseCount = 8;
        for (let i = 0; i < noiseCount; i++) {
            const nx = seededRandom(i + Date.now() % 1000) * canvas.width;
            const ny = seededRandom(i + 500 + Date.now() % 1000) * canvas.height;
            ctx.save();
            ctx.globalAlpha = 0.01;
            ctx.fillStyle = `hsl(${(Date.now() / 100 + i * 45) % 360}, 50%, 50%)`;
            ctx.fillRect(nx, ny, 2, 2);
            ctx.restore();
        }

        const forensic = wm?.forensicCode || seed.slice(0, 16);
        const bits = Array.from(forensic).flatMap(char => char.charCodeAt(0).toString(2).padStart(8, '0').split(''));
        ctx.save();
        ctx.globalAlpha = 0.035;
        ctx.fillStyle = '#ffffff';
        const originX = (Math.floor(time / 8) * 37) % Math.max(1, canvas.width - 180);
        const originY = (Math.floor(time / 8) * 53) % Math.max(1, canvas.height - 80);
        bits.forEach((bit, index) => {
            if (bit === '1') ctx.fillRect(originX + (index % 32) * 5, originY + Math.floor(index / 32) * 5, 2, 2);
        });
        ctx.font = '8px monospace';
        ctx.fillText(forensic, originX, originY + 55);
        ctx.restore();

        // Version indicator
        ctx.save();
        ctx.font = '11px monospace';
        ctx.fillStyle = 'rgba(0, 255, 0, 0.4)';
        ctx.fillText('Protected v4.0 🔒', 10, canvas.height - 10);
        ctx.restore();

        animationFrameRef.current = requestAnimationFrame(renderWatermarks);
    }, [watermarkData, studentName, groupName, userId]);

    useEffect(() => {
        renderWatermarks();
        return () => {
            if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
        };
    }, [renderWatermarks]);

    // ═══════════════════════════════════════
    // PLAYER CONTROLS LOGIC
    // ═══════════════════════════════════════
    useEffect(() => {
        const vid = videoRef.current;
        if (!vid) return;
        const onTimeUpdate = () => {
            setCurrentTime(vid.currentTime);
            if (vid.duration) setProgress((vid.currentTime / vid.duration) * 100);
        };
        const onLoaded = () => setDuration(vid.duration || 0);
        const onVolChange = () => {
            setVolume(vid.volume);
            setIsMuted(vid.muted);
        };
        vid.addEventListener('timeupdate', onTimeUpdate);
        vid.addEventListener('loadedmetadata', onLoaded);
        vid.addEventListener('durationchange', onLoaded);
        vid.addEventListener('volumechange', onVolChange);
        return () => {
            vid.removeEventListener('timeupdate', onTimeUpdate);
            vid.removeEventListener('loadedmetadata', onLoaded);
            vid.removeEventListener('durationchange', onLoaded);
            vid.removeEventListener('volumechange', onVolChange);
        };
    }, [sourceType, loading]);

    useEffect(() => {
        const effective = liveRestrictions.riskScore >= serverRestrictions.riskScore ? liveRestrictions : serverRestrictions;
        if (hlsRef.current && effective.qualityCap !== null) {
            hlsRef.current.autoLevelCapping = effective.qualityCap;
            hlsRef.current.nextLevel = effective.qualityCap;
        }
        if (!effective.fullscreenAllowed && document.fullscreenElement) document.exitFullscreen().catch(() => { });
    }, [liveRestrictions, serverRestrictions]);

    // Fullscreen change listener
    useEffect(() => {
        const handler = () => setIsFullscreen(!!document.fullscreenElement);
        document.addEventListener('fullscreenchange', handler);
        return () => document.removeEventListener('fullscreenchange', handler);
    }, []);

    const togglePlay = () => {
        const vid = videoRef.current;
        if (!vid) return;
        if (vid.paused) vid.play().catch(() => { });
        else vid.pause();
    };

    const skip = (seconds: number) => {
        const vid = videoRef.current;
        if (!vid) return;
        vid.currentTime = Math.max(0, Math.min(vid.duration || 0, vid.currentTime + seconds));
    };

    const handleVolumeChange = (val: number) => {
        const vid = videoRef.current;
        if (!vid) return;
        vid.volume = val;
        vid.muted = val === 0;
        setVolume(val);
        setIsMuted(val === 0);
    };

    const toggleMute = () => {
        const vid = videoRef.current;
        if (!vid) return;
        vid.muted = !vid.muted;
        setIsMuted(vid.muted);
    };

    const toggleFullscreen = () => {
        const effective = liveRestrictions.riskScore >= serverRestrictions.riskScore ? liveRestrictions : serverRestrictions;
        if (!effective.fullscreenAllowed) {
            reportViolation('fullscreen_blocked', 'Fullscreen disabled by current risk policy', 'low');
            return;
        }
        const el = containerRef.current;
        if (!el) return;
        if (document.fullscreenElement) document.exitFullscreen().catch(() => { });
        else el.requestFullscreen().catch(() => { });
    };

    const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
        const vid = videoRef.current;
        const bar = progressBarRef.current;
        if (!vid || !bar || !vid.duration) return;
        const rect = bar.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        vid.currentTime = pct * vid.duration;
    };

    const formatTime = (sec: number) => {
        if (!sec || !isFinite(sec)) return '0:00';
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

    // Controls auto-hide
    const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const handleMouseMove = () => {
        setShowControls(true);
        if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
        controlsTimeoutRef.current = setTimeout(() => setShowControls(false), 3000);
    };

    // ═══════════════════════════════════════
    // RENDER
    // ═══════════════════════════════════════

    const effectiveRestrictions = liveRestrictions.riskScore >= serverRestrictions.riskScore ? liveRestrictions : serverRestrictions;

    if (consentChecked && consentRequired) {
        return (
            <div className="fixed inset-0 z-[9999] bg-black/95 flex items-center justify-center p-4 text-white" dir="rtl">
                <div className="w-full max-w-lg rounded-2xl border border-white/15 bg-slate-950 p-6 shadow-2xl">
                    <Shield className="mx-auto mb-4 h-14 w-14 text-teal-400" />
                    <h2 className="mb-3 text-center text-2xl font-bold">سياسة حماية الفيديو</h2>
                    <p className="mb-4 text-sm leading-7 text-slate-300">الفيديو مشفر ومربوط بحسابك وجهازك. تظهر عليه علامة مائية باسمك ومعرف جلستك، وتُسجل محاولات الالتقاط المؤكدة وقد تؤدي إلى تسجيل الخروج أو تعليق الحساب وإبلاغ مدرسك.</p>
                    <label className="mb-5 flex cursor-pointer items-start gap-3 rounded-xl bg-white/5 p-4 text-sm leading-6">
                        <input type="checkbox" className="mt-1 h-4 w-4" checked={consentAccepted} onChange={event => setConsentAccepted(event.target.checked)} />
                        <span>أوافق على عدم تصوير أو تسجيل أو إعادة نشر المحتوى، وعلى تطبيق إجراءات الحماية الموضحة.</span>
                    </label>
                    <div className="flex gap-3">
                        <button disabled={!consentAccepted || consentBusy} onClick={acceptVideoTerms} className="flex-1 rounded-xl bg-teal-600 px-4 py-3 font-bold disabled:cursor-not-allowed disabled:opacity-40">{consentBusy ? 'جارٍ الحفظ…' : 'موافق وابدأ المشاهدة'}</button>
                        <button onClick={onClose} className="rounded-xl border border-white/20 px-4 py-3">إلغاء</button>
                    </div>
                </div>
            </div>
        );
    }

    if (suspensionInfo) {
        return (
            <div className="fixed inset-0 z-[9999] bg-black flex flex-col items-center justify-center text-white">
                <Lock className="w-20 h-20 text-red-500 mb-6" />
                <h2 className="text-2xl font-bold mb-3 text-center px-4">⛔ تم تعليق حسابك مؤقتاً</h2>
                <p className="text-base text-gray-400 mb-2 text-center px-4">{suspensionInfo.reason}</p>
                <p className="text-sm text-gray-500 mb-8">
                    سيتم إعادة التفعيل في: {new Date(suspensionInfo.until).toLocaleString('ar-EG')}
                </p>
                <button
                    onClick={onClose}
                    className="px-8 py-3 bg-gray-700 text-white rounded-xl text-lg hover:bg-gray-600"
                >
                    إغلاق
                </button>
            </div>
        );
    }

    return (
        <div
            ref={containerRef}
            className="fixed inset-0 z-[9999] bg-black flex items-center justify-center select-none overflow-hidden secure-video-container"
            onMouseMove={handleMouseMove}
            onDragStart={(e) => e.preventDefault()}
            onCopy={(e) => e.preventDefault()}
            style={{ WebkitUserSelect: 'none', userSelect: 'none', WebkitTouchCallout: 'none' } as React.CSSProperties}
        >
            {/* SCREEN BLOCKED OVERLAY */}
            {isBlocked && !securityViolation && (
                <div className="absolute inset-0 z-[10001] bg-black flex flex-col items-center justify-center text-white">
                    <ShieldAlert className="w-20 h-20 text-yellow-500 mb-6 animate-bounce" />
                    <h2 className="text-2xl sm:text-3xl font-bold mb-3 text-center px-4">
                        ⚠️ تم إيقاف المحاضرة
                    </h2>
                    <p className="text-base sm:text-lg text-gray-400 mb-2 text-center px-4">
                        لا يُسمح بتصوير الشاشة أو تسجيل الفيديو
                    </p>
                    <p className="text-sm text-gray-500 mb-8 text-center px-4">
                        تم تسجيل هذه المحاولة وسيتم مراجعتها
                    </p>
                    <button
                        onClick={unblockScreen}
                        className="px-8 py-4 bg-gradient-to-r from-teal-600 to-teal-500 text-white rounded-xl text-lg font-bold hover:from-teal-700 hover:to-teal-600 transition-all shadow-lg active:scale-95"
                    >
                        ▶️ متابعة المشاهدة
                    </button>
                </div>
            )}

            {/* FORCE LOGOUT VIOLATION SCREEN */}
            {securityViolation && (
                <div className="absolute inset-0 z-[10002] bg-black flex flex-col items-center justify-center text-white">
                    <Shield className="w-24 h-24 text-red-600 mb-6 animate-pulse" />
                    <h2 className="text-3xl font-bold mb-2">تم اكتشاف انتهاك أمني!</h2>
                    <p className="text-xl text-gray-400 mb-4">{securityViolation}</p>
                    <p className="text-lg text-gray-500">جاري تسجيل الخروج...</p>
                </div>
            )}

            {/* VIDEO */}
            {sourceType === 'youtube' || sourceType === 'drive' || sourceType === 'vdocipher' ? (
                <iframe
                    src={embedUrl}
                    className="w-full h-full object-contain pointer-events-auto"
                    allow="autoplay; encrypted-media; fullscreen"
                    allowFullScreen
                    style={{ pointerEvents: 'auto' }}
                />
            ) : (
                <video
                    ref={videoRef}
                    className="w-full h-full object-contain"
                    playsInline
                    disablePictureInPicture
                    disableRemotePlayback
                    controlsList="nodownload nofullscreen noremoteplayback"
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                />
            )}

            {/* MULTI-LAYER OVERLAYS */}
            <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none z-[50]" />
            {effectiveRestrictions.qualityCap !== null && (
                <div className="absolute right-3 top-3 z-[70] rounded-lg bg-amber-500/90 px-3 py-1 text-xs font-bold text-black">جودة منخفضة بسبب مستوى المخاطر</div>
            )}
            <div className="absolute inset-0 pointer-events-none z-[51]"
                style={{ background: 'linear-gradient(135deg, transparent 0%, rgba(255,255,255,0.003) 50%, transparent 100%)', mixBlendMode: 'overlay' }}
            />
            <div className="absolute inset-0 pointer-events-none z-[52]"
                style={{ backdropFilter: 'contrast(1.001)', WebkitBackdropFilter: 'contrast(1.001)' }}
            />

            {/* CONTROLS */}
            {(sourceType === 'hls' || sourceType === 'mp4') && !loading && !error && !isBlocked && (
                <>
                    {/* Tap-to-toggle play (center area) */}
                    <div
                        className="absolute inset-0 z-[55] cursor-pointer"
                        onClick={togglePlay}
                        onDoubleClick={toggleFullscreen}
                    />

                    {/* Controls overlay */}
                    <div
                        className={`absolute inset-0 z-[60] flex flex-col justify-between transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
                            }`}
                    >
                        {/* Top bar */}
                        <div className="flex justify-between items-center p-4 bg-gradient-to-b from-black/80 to-transparent">
                            <button onClick={() => {
                                if (sessionId) {
                                    fetch(`${API_BASE}/secure-video/kill-session`, {
                                        method: 'POST',
                                        headers: {
                                            'Content-Type': 'application/json',
                                            'Authorization': `Bearer ${localStorage.getItem('authToken') || ''}`,
                                        },
                                        body: JSON.stringify({ sessionId, sessionToken, reason: 'player_closed' })
                                    }).catch(() => { });
                                }
                                onClose();
                            }} className="p-2 bg-white/10 rounded-full hover:bg-white/20 text-white backdrop-blur-sm">
                                <X className="w-6 h-6" />
                            </button>
                            <div className="text-white/60 text-xs">
                                🔒 محمي
                            </div>
                        </div>

                        {/* Center play indicator (big) */}
                        {!isPlaying && (
                            <div className="flex-1 flex items-center justify-center">
                                <button onClick={togglePlay} className="p-5 bg-white/10 rounded-full backdrop-blur-sm hover:bg-white/20 transition-all">
                                    <Play className="w-14 h-14 text-white" fill="white" />
                                </button>
                            </div>
                        )}
                        {isPlaying && <div className="flex-1" />}

                        {/* Bottom controls */}
                        <div className="bg-gradient-to-t from-black/90 via-black/60 to-transparent px-4 pb-4 pt-8">
                            {/* Progress bar */}
                            <div
                                ref={progressBarRef}
                                className="relative w-full h-2 bg-white/20 rounded-full cursor-pointer mb-3 group"
                                onClick={handleProgressClick}
                            >
                                {/* Buffered */}
                                <div className="absolute inset-y-0 left-0 bg-white/30 rounded-full" style={{ width: `${progress}%` }} />
                                {/* Played */}
                                <div className="absolute inset-y-0 left-0 bg-teal-500 rounded-full transition-all" style={{ width: `${progress}%` }} />
                                {/* Thumb */}
                                <div
                                    className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-teal-400 rounded-full shadow-lg opacity-0 group-hover:opacity-100 transition-opacity"
                                    style={{ left: `calc(${progress}% - 8px)` }}
                                />
                            </div>

                            {/* Control buttons row */}
                            <div className="flex items-center justify-between">
                                {/* Left: time */}
                                <div className="text-white/80 text-xs font-mono min-w-[90px]" dir="ltr">
                                    {formatTime(currentTime)} / {formatTime(duration)}
                                </div>

                                {/* Center: play controls */}
                                <div className="flex items-center gap-3">
                                    <button onClick={() => skip(-10)} className="p-2 text-white/80 hover:text-white transition-colors" title="ارجع 10 ثواني">
                                        <RotateCcw className="w-5 h-5" />
                                    </button>
                                    <button onClick={togglePlay} className="p-3 bg-white/10 rounded-full hover:bg-white/20 text-white transition-all">
                                        {isPlaying ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6" fill="white" />}
                                    </button>
                                    <button onClick={() => skip(10)} className="p-2 text-white/80 hover:text-white transition-colors" title="تقدم 10 ثواني">
                                        <RotateCw className="w-5 h-5" />
                                    </button>
                                </div>

                                {/* Right: volume + fullscreen */}
                                <div className="flex items-center gap-2 min-w-[120px] justify-end">
                                    <button onClick={toggleMute} className="p-1.5 text-white/80 hover:text-white transition-colors">
                                        {isMuted || volume === 0 ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                                    </button>
                                    <input
                                        type="range"
                                        min={0}
                                        max={1}
                                        step={0.05}
                                        value={isMuted ? 0 : volume}
                                        onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                                        className="w-16 h-1 accent-teal-500 cursor-pointer"
                                    />
                                    <button onClick={toggleFullscreen} className="p-1.5 text-white/80 hover:text-white transition-colors" title="ملء الشاشة">
                                        {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </>
            )}

            {/* CLOSE FOR IFRAMES */}
            {(sourceType === 'youtube' || sourceType === 'drive') && !isBlocked && (
                <button onClick={onClose} className="absolute top-6 left-6 z-[70] p-3 bg-red-600 rounded-full hover:bg-red-700 text-white shadow-lg">
                    <X className="w-6 h-6" />
                </button>
            )}

            {/* LOADING */}
            {loading && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/90 z-[80] pointer-events-none">
                    <Loader2 className="w-12 h-12 text-teal-500 animate-spin mb-4" />
                    <p className="text-gray-400 text-sm">جاري تحميل الفيديو المشفّر...</p>
                </div>
            )}

            {/* ERROR */}
            {error && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/90 z-[80]">
                    <ShieldAlert className="w-16 h-16 text-red-500 mb-4" />
                    <p className="text-white text-lg mb-4">{error}</p>
                    <button onClick={onClose} className="px-6 py-3 bg-gray-700 rounded-lg text-white hover:bg-gray-600">إغلاق</button>
                </div>
            )}
        </div>
    );
}
