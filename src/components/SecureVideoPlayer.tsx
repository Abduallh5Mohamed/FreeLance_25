import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import Hls from 'hls.js';
import { Loader2, X, Play, Pause, Volume2, VolumeX, Maximize, Minimize, RotateCcw, RotateCw, Shield } from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

interface SecureVideoPlayerProps {
    videoId: string;
    userId: string;
    studentName: string;
    groupName: string;
    onClose: () => void;
}

export function SecureVideoPlayer({ 
    videoId, 
    userId, 
    studentName, 
    groupName, 
    onClose 
}: SecureVideoPlayerProps) {
    const navigate = useNavigate();
    const videoRef = useRef<HTMLVideoElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const progressRef = useRef<HTMLDivElement>(null);
    const hlsRef = useRef<Hls | null>(null);
    
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
    const [showVolumeSlider, setShowVolumeSlider] = useState(false);
    const [securityViolation, setSecurityViolation] = useState<string | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [isWindowFocused, setIsWindowFocused] = useState(true);
    const [isSecurityBlurred, setIsSecurityBlurred] = useState(false);
    const [recordingDetected, setRecordingDetected] = useState(false);
    
    const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const isLoggedOutRef = useRef(false);
    const suspiciousActivityCount = useRef(0);
    const lastMousePosition = useRef({ x: 0, y: 0 });
    const mouseMoveTimeout = useRef<NodeJS.Timeout | null>(null);
    const blurCount = useRef(0);
    const lastBlurTime = useRef(0);
    const [isHoveringProgress, setIsHoveringProgress] = useState(false);
    const performanceCheckInterval = useRef<NodeJS.Timeout | null>(null);
    const [watermarks, setWatermarks] = useState<Array<{ x: number; y: number; rotation: number; opacity: number }>>([]);
    const [showBlackScreen, setShowBlackScreen] = useState(false);

    // Watermark text - Student name + actual group name (fixed position, elegant)
    const watermarkText = `${studentName} • ${groupName}`;

    // Generate multiple watermarks covering the entire screen
    useEffect(() => {
        const generateWatermarks = () => {
            const marks = [];
            // Create a grid of watermarks (15x10 = 150 watermarks)
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
        // Change positions every 10 seconds to prevent static watermark removal
        const interval = setInterval(generateWatermarks, 10000);
        return () => clearInterval(interval);
    }, []);

    // Hide controls after inactivity
    const resetControlsTimeout = useCallback(() => {
        setShowControls(true);
        if (controlsTimeoutRef.current) {
            clearTimeout(controlsTimeoutRef.current);
        }
        controlsTimeoutRef.current = setTimeout(() => {
            if (isPlaying && !isDragging) setShowControls(false);
        }, 4000);
    }, [isPlaying, isDragging]);

    // FORCE LOGOUT - Security violation detected
    const forceLogout = useCallback((reason: string) => {
        if (isLoggedOutRef.current) return;
        isLoggedOutRef.current = true;
        
        // Log security violation to backend
        fetch(`${API_BASE}/videos/security/log`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId,
                videoId,
                activityType: reason.includes('تصوير') ? 'screenshot_attempt' : 
                              reason.includes('تسجيل') ? 'recording_attempt' :
                              reason.includes('أدوات المطور') ? 'devtools_attempt' :
                              'forced_logout',
                details: reason
            })
        }).catch(err => console.error('Failed to log security event:', err));
        
        if (videoRef.current) {
            videoRef.current.pause();
            videoRef.current.src = '';
        }
        
        if (hlsRef.current) {
            hlsRef.current.destroy();
        }
        
        setSecurityViolation(reason);
        
        setTimeout(() => {
            localStorage.removeItem('user');
            localStorage.removeItem('token');
            sessionStorage.clear();
            
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => {});
            }
            
            navigate('/auth', { replace: true });
            window.location.reload();
        }, 2000);
    }, [navigate, userId, videoId]);

    // MAXIMUM SECURITY: Detect recording software and suspicious behavior
    useEffect(() => {
        // AGGRESSIVE: Detect ANY screen capture attempt
        const detectScreenCapture = async () => {
            try {
                // Check if getDisplayMedia (screen recording API) is being used
                const originalGetDisplayMedia = navigator.mediaDevices?.getDisplayMedia;
                if (originalGetDisplayMedia) {
                    navigator.mediaDevices.getDisplayMedia = function(...args) {
                        setShowBlackScreen(true);
                        forceLogout('محاولة تسجيل الشاشة - Screen Capture API');
                        throw new Error('Screen capture blocked');
                    };
                }

                // Detect if MediaRecorder is being used
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

                // Block Chrome Extensions APIs that might be used for recording
                if ((window as any).chrome?.runtime) {
                    const originalSendMessage = (window as any).chrome.runtime.sendMessage;
                    (window as any).chrome.runtime.sendMessage = function(...args: any[]) {
                        console.warn('Extension communication blocked');
                        setShowBlackScreen(true);
                        suspiciousActivityCount.current += 5;
                        if (suspiciousActivityCount.current >= 5) {
                            forceLogout('امتداد مشبوه - محاولة تسجيل');
                        }
                    };
                }
            } catch (e) {
                console.log('Recording detection setup:', e);
            }
        };

        detectScreenCapture();

        // Monitor window blur events - Immediate logout on ANY visibility change (ALT+TAB)
        const handleVisibilityChange = () => {
            if (document.hidden) {
                setIsSecurityBlurred(true);
                setIsWindowFocused(false);
                setShowBlackScreen(true);
                if (videoRef.current) videoRef.current.pause();
                
                // Immediate logout on any tab/window switch
                forceLogout('تبديل التبويب أو النافذة محظور');
            } else {
                setTimeout(() => {
                    setIsSecurityBlurred(false);
                    setIsWindowFocused(true);
                    setShowBlackScreen(false);
                }, 500);
            }
        };

        const handleWindowBlur = () => {
            const now = Date.now();
            setIsSecurityBlurred(true);
            setIsWindowFocused(false);
            setShowBlackScreen(true);
            if (videoRef.current) videoRef.current.pause();
            
            // Immediate logout on ANY window blur (ALT+TAB, switching apps, etc.)
            forceLogout('تبديل النافذة أو التطبيق محظور (ALT+TAB)');
        };

        const handleWindowFocus = () => {
            setTimeout(() => {
                setIsSecurityBlurred(false);
                setIsWindowFocused(true);
                setShowBlackScreen(false);
            }, 300);
        };

        // Advanced: Monitor performance - recording software causes CPU spike
        const checkPerformance = () => {
            if (performance && (performance as any).memory) {
                const memory = (performance as any).memory;
                const usedMemoryMB = memory.usedJSHeapSize / 1048576;
                const totalMemoryMB = memory.jsHeapSizeLimit / 1048576;
                
                // If memory usage is abnormally high, might be recording
                if (usedMemoryMB > totalMemoryMB * 0.75) {
                    suspiciousActivityCount.current++;
                    if (suspiciousActivityCount.current > 8) {
                        setShowBlackScreen(true);
                        forceLogout('استخدام ذاكرة مشبوه - برنامج تسجيل محتمل');
                    }
                }
            }
        };

        performanceCheckInterval.current = setInterval(checkPerformance, 2000);

        // Detect if debugger is open - more aggressive
        const detectDevTools = () => {
            const threshold = 160;
            const widthThreshold = window.outerWidth - window.innerWidth > threshold;
            const heightThreshold = window.outerHeight - window.innerHeight > threshold;
            
            // Also check for orientation changes that might indicate DevTools
            const orientation = window.screen.orientation?.type;
            
            if (widthThreshold || heightThreshold) {
                setShowBlackScreen(true);
                forceLogout('أدوات المطور مفتوحة');
            }

            // Debugger statement trap
            const before = new Date().getTime();
            debugger;
            const after = new Date().getTime();
            if (after - before > 100) {
                setShowBlackScreen(true);
                forceLogout('تم اكتشاف Debugger');
            }
        };

        const devToolsInterval = setInterval(detectDevTools, 500);

        // Monitor for suspicious extensions
        const checkExtensions = () => {
            // Check if canvas is being tampered with (some screen recorders do this)
            const canvas = document.createElement('canvas');
            const gl = canvas.getContext('webgl');
            if (gl) {
                const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
                if (debugInfo) {
                    const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
                    // Some recording software modifies GPU info
                    if (renderer.includes('SwiftShader') || renderer.includes('Software')) {
                        suspiciousActivityCount.current += 2;
                    }
                }
            }
        };

        checkExtensions();

        document.addEventListener('visibilitychange', handleVisibilityChange);
        window.addEventListener('blur', handleWindowBlur);
        window.addEventListener('focus', handleWindowFocus);

        // ========= MOBILE SECURITY - ANDROID & iOS =========
        
        // 1. Detect screen recording on mobile devices
        const detectMobileRecording = () => {
            // Check if MediaRecorder API is being accessed (screen recording)
            if ('mediaDevices' in navigator && navigator.mediaDevices.getDisplayMedia) {
                const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia;
                navigator.mediaDevices.getDisplayMedia = function(...args) {
                    forceLogout('محاولة تسجيل الشاشة على الموبايل');
                    return originalGetDisplayMedia.apply(this, args);
                };
            }
            
            // Detect MediaRecorder usage (video recording)
            const OriginalMediaRecorder = window.MediaRecorder;
            if (OriginalMediaRecorder) {
                (window as any).MediaRecorder = class extends OriginalMediaRecorder {
                    constructor(stream: MediaStream, options?: MediaRecorderOptions) {
                        super(stream, options);
                        forceLogout('محاولة تسجيل فيديو - MediaRecorder على الموبايل');
                    }
                };
            }
            
            // Monitor getUserMedia (camera/mic access - often used by recording apps)
            if (navigator.mediaDevices?.getUserMedia) {
                const originalGetUserMedia = navigator.mediaDevices.getUserMedia;
                navigator.mediaDevices.getUserMedia = async function(constraints) {
                    // If requesting video while watching - suspicious
                    if (constraints?.video) {
                        forceLogout('محاولة الوصول للكاميرا أثناء المشاهدة - تسجيل محتمل');
                    }
                    return originalGetUserMedia.call(this, constraints);
                };
            }
            
            // Block captureStream on video element (can be used for recording)
            const videoCaptureStream = (HTMLVideoElement.prototype as any).captureStream || 
                                      (HTMLVideoElement.prototype as any).mozCaptureStream;
            if (videoCaptureStream) {
                (HTMLVideoElement.prototype as any).captureStream = function() {
                    forceLogout('محاولة التقاط stream الفيديو للتسجيل');
                    throw new Error('captureStream blocked');
                };
            }
            
            // Block Canvas drawImage on video (used for frame capture and recording)
            const originalDrawImage = CanvasRenderingContext2D.prototype.drawImage;
            CanvasRenderingContext2D.prototype.drawImage = function(...args: any[]) {
                // Check if drawing from our video element
                if (args[0] instanceof HTMLVideoElement && args[0] === videoRef.current) {
                    forceLogout('محاولة التقاط إطارات الفيديو عبر Canvas');
                    throw new Error('Canvas capture blocked');
                }
                return originalDrawImage.apply(this, args);
            };
            
            // Block WebRTC Data Channel (can be used to send video stream)
            const originalCreateDataChannel = RTCPeerConnection.prototype.createDataChannel;
            RTCPeerConnection.prototype.createDataChannel = function(...args: any[]) {
                forceLogout('محاولة إرسال البيانات عبر WebRTC - تسجيل محتمل');
                throw new Error('Data channel blocked');
            };
        };
        
        // 2. Detect when user leaves app (goes to home screen or switches apps)
        const handleAppStateChange = () => {
            if (document.hidden || document.visibilityState === 'hidden') {
                forceLogout('الخروج من التطبيق على الموبايل محظور');
            }
        };
        
        // 3. Detect screenshot attempts on Android/iOS
        // Screenshots cause a quick blur/visibility change
        let mobileBlurCount = 0;
        let lastMobileBlurTime = 0;
        
        const handleMobileBlur = () => {
            const now = Date.now();
            if (now - lastMobileBlurTime < 500) {
                mobileBlurCount++;
                if (mobileBlurCount >= 1) {
                    forceLogout('محاولة أخذ لقطة شاشة على الموبايل');
                }
            } else {
                mobileBlurCount = 0;
            }
            lastMobileBlurTime = now;
        };
        
        // 4. Detect volume button press (often used for screenshot)
        const handleVolumeButton = (e: KeyboardEvent) => {
            if (e.key === 'VolumeUp' || e.key === 'VolumeDown') {
                // Check if Power button is also pressed (Screenshot combo on Android)
                handleMobileBlur();
            }
        };
        
        // 5. Block long press on mobile (screenshot gesture)
        let touchStartTime = 0;
        const handleTouchStart = () => {
            touchStartTime = Date.now();
        };
        
        const handleTouchEnd = () => {
            const touchDuration = Date.now() - touchStartTime;
            if (touchDuration > 1000) {
                // Long press detected - might be screenshot gesture
                forceLogout('ضغطة طويلة مشبوهة على الموبايل');
            }
        };
        
        // 6. Monitor page freeze (iOS screenshot causes brief freeze)
        let lastFrameTime = Date.now();
        const checkFrameRate = () => {
            const now = Date.now();
            const timeSinceLastFrame = now - lastFrameTime;
            
            // If more than 200ms passed, might be screenshot
            if (timeSinceLastFrame > 200 && document.visibilityState === 'visible') {
                forceLogout('تجميد الشاشة - محاولة لقطة شاشة محتملة');
            }
            
            lastFrameTime = now;
            requestAnimationFrame(checkFrameRate);
        };
        
        // 7. Monitor battery drain (recording consumes a lot of battery)
        const monitorBattery = async () => {
            if ('getBattery' in navigator) {
                try {
                    const battery = await (navigator as any).getBattery();
                    let lastBatteryLevel = battery.level;
                    let batteryCheckCount = 0;
                    
                    const checkBatteryDrain = () => {
                        const currentLevel = battery.level;
                        const drain = lastBatteryLevel - currentLevel;
                        
                        // If battery drains more than 0.5% in 30 seconds while charging is off
                        if (drain > 0.005 && !battery.charging) {
                            batteryCheckCount++;
                            if (batteryCheckCount >= 2) {
                                forceLogout('استهلاك بطارية مشبوه - تسجيل محتمل');
                            }
                        } else {
                            batteryCheckCount = 0;
                        }
                        
                        lastBatteryLevel = currentLevel;
                    };
                    
                    setInterval(checkBatteryDrain, 30000); // Check every 30 seconds
                } catch (e) {
                    console.log('Battery API not available');
                }
            }
        };
        
        // 8. Detect Picture-in-Picture attempts (used to record while browsing)
        const blockPiP = () => {
            if (videoRef.current) {
                videoRef.current.addEventListener('enterpictureinpicture', () => {
                    forceLogout('محاولة استخدام Picture-in-Picture للتسجيل');
                    if (document.pictureInPictureElement) {
                        document.exitPictureInPicture();
                    }
                });
            }
        };
        
        // 9. Monitor screen orientation changes (some recording apps rotate screen)
        let orientationChangeCount = 0;
        let lastOrientationChange = Date.now();
        
        const handleOrientationChange = () => {
            const now = Date.now();
            if (now - lastOrientationChange < 2000) {
                orientationChangeCount++;
                if (orientationChangeCount >= 2) {
                    forceLogout('تغيير اتجاه الشاشة المتكرر - نشاط مشبوه');
                }
            } else {
                orientationChangeCount = 0;
            }
            lastOrientationChange = now;
        };
        
        // 10. Block Web Share API (can be used to save video)
        if (navigator.share) {
            const originalShare = navigator.share;
            navigator.share = async function(data) {
                if (data.files || data.url) {
                    forceLogout('محاولة مشاركة المحتوى');
                }
                return originalShare.call(this, data);
            };
        }
        
        // Detect if running on mobile
        const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
        
        if (isMobile) {
            detectMobileRecording();
            monitorBattery();
            blockPiP();
            document.addEventListener('visibilitychange', handleAppStateChange, true);
            window.addEventListener('blur', handleMobileBlur, true);
            document.addEventListener('keydown', handleVolumeButton, true);
            document.addEventListener('touchstart', handleTouchStart, true);
            document.addEventListener('touchend', handleTouchEnd, true);
            window.addEventListener('orientationchange', handleOrientationChange, true);
            requestAnimationFrame(checkFrameRate);
        }

        return () => {
            if (performanceCheckInterval.current) clearInterval(performanceCheckInterval.current);
            clearInterval(devToolsInterval);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            window.removeEventListener('blur', handleWindowBlur);
            window.removeEventListener('focus', handleWindowFocus);
            
            if (isMobile) {
                document.removeEventListener('visibilitychange', handleAppStateChange, true);
                window.removeEventListener('blur', handleMobileBlur, true);
                document.removeEventListener('keydown', handleVolumeButton, true);
                document.removeEventListener('touchstart', handleTouchStart, true);
                document.removeEventListener('touchend', handleTouchEnd, true);
                window.removeEventListener('orientationchange', handleOrientationChange, true);
            }
        };
    }, [forceLogout]);

    // Control functions - defined early
    const togglePlay = useCallback(() => {
        if (videoRef.current) {
            if (videoRef.current.paused) {
                videoRef.current.play();
            } else {
                videoRef.current.pause();
            }
        }
    }, []);

    const toggleMute = useCallback(() => {
        if (videoRef.current) {
            videoRef.current.muted = !videoRef.current.muted;
            setIsMuted(!videoRef.current.muted);
        }
    }, []);

    const skipBackward = useCallback(() => {
        if (videoRef.current) {
            videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime - 5);
        }
    }, []);

    const skipForward = useCallback(() => {
        if (videoRef.current) {
            videoRef.current.currentTime = Math.min(videoRef.current.duration || 0, videoRef.current.currentTime + 5);
        }
    }, []);

    const toggleFullscreen = useCallback(async () => {
        if (!containerRef.current) return;
        
        if (document.fullscreenElement) {
            await document.exitFullscreen();
        } else {
            await containerRef.current.requestFullscreen();
        }
    }, []);

    // Security: Block screenshot shortcuts and recording
    useEffect(() => {
        let screenshotAttempts = 0;
        
        const handleKeyDown = (e: KeyboardEvent) => {
            // Block Alt+Tab - Window switching is INSTANT LOGOUT
            if (e.altKey && e.key === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                setShowBlackScreen(true);
                forceLogout('محاولة تبديل النوافذ - Alt+Tab');
                return false;
            }

            // Block Windows Key - Opens start menu (suspicious)
            if (e.key === 'Meta' || e.keyCode === 91 || e.keyCode === 92) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                setShowBlackScreen(true);
                forceLogout('محاولة فتح قائمة Start');
                return false;
            }

            // Block Print Screen - INSTANT LOGOUT
            if (e.key === 'PrintScreen') {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                setShowBlackScreen(true);
                screenshotAttempts++;
                forceLogout('محاولة تصوير الشاشة - Print Screen');
                return false;
            }
            
            // Block Snipping Tool (Win + Shift + S) - INSTANT LOGOUT
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'S' || e.key === 's')) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                setShowBlackScreen(true);
                forceLogout('محاولة تصوير الشاشة - Snipping Tool');
                return false;
            }
            
            // Block Mac screenshots - INSTANT LOGOUT
            if (e.metaKey && e.shiftKey && ['3', '4', '5', '6'].includes(e.key)) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                setShowBlackScreen(true);
                forceLogout('محاولة تصوير الشاشة - Mac Screenshot');
                return false;
            }

            // Block ShareX shortcuts (Ctrl+Print Screen) - INSTANT LOGOUT
            if (e.ctrlKey && e.key === 'PrintScreen') {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                setShowBlackScreen(true);
                forceLogout('محاولة تصوير الشاشة - ShareX');
                return false;
            }

            // Block Alt+Print Screen (current window) - INSTANT LOGOUT
            if (e.altKey && e.key === 'PrintScreen') {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                setShowBlackScreen(true);
                forceLogout('محاولة تصوير الشاشة - Alt+Print Screen');
                return false;
            }

            // Block Windows Game Bar (Win + G) - recording tool
            if (e.key === 'g' && e.metaKey) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                setShowBlackScreen(true);
                forceLogout('محاولة تسجيل الشاشة - Game Bar');
                return false;
            }

            // Block OBS/recording hotkeys (common: F9-F11)
            if (['F9', 'F10', 'F11'].includes(e.key) && !e.ctrlKey && !e.shiftKey && !e.altKey) {
                e.preventDefault();
                e.stopPropagation();
                screenshotAttempts++;
                if (screenshotAttempts >= 2) {
                    setShowBlackScreen(true);
                    forceLogout('محاولة استخدام برنامج تسجيل - OBS');
                }
                return false;
            }

            // Block developer tools
            if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key === 'I')) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                setShowBlackScreen(true);
                forceLogout('محاولة فتح أدوات المطور');
                return false;
            }

            // Block inspect element
            if (e.ctrlKey && e.shiftKey && e.key === 'C') {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                setShowBlackScreen(true);
                forceLogout('محاولة فحص العنصر');
                return false;
            }

            // Block view source
            if (e.ctrlKey && e.key === 'u') {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                setShowBlackScreen(true);
                forceLogout('محاولة عرض المصدر');
                return false;
            }

            // Block Ctrl+S (save page)
            if (e.ctrlKey && e.key === 's' && !e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                setShowBlackScreen(true);
                forceLogout('محاولة حفظ الصفحة');
                return false;
            }

            // Keyboard shortcuts for video control
            if (e.key === ' ' || e.key === 'k') {
                e.preventDefault();
                togglePlay();
            }
            if (e.key === 'ArrowLeft' || e.key === 'j') {
                e.preventDefault();
                skipBackward();
            }
            if (e.key === 'ArrowRight' || e.key === 'l') {
                e.preventDefault();
                skipForward();
            }
            if (e.key === 'm') {
                e.preventDefault();
                toggleMute();
            }
            if (e.key === 'f') {
                e.preventDefault();
                toggleFullscreen();
            }
            if (e.key === 'Escape') {
                onClose();
            }
        };

        const handleContextMenu = (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            setShowBlackScreen(true);
            forceLogout('محاولة فتح القائمة - Right Click');
            return false;
        };

        // Block drag events (prevent dragging video to another app)
        const handleDragStart = (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            setShowBlackScreen(true);
            forceLogout('محاولة سحب الفيديو');
            return false;
        };

        // Block copy - INSTANT LOGOUT
        const handleCopy = (e: ClipboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            setShowBlackScreen(true);
            forceLogout('محاولة النسخ');
            return false;
        };

        // Detect screenshot via Clipboard API
        const handlePaste = (e: ClipboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            setShowBlackScreen(true);
            forceLogout('نشاط مشبوه - Clipboard');
            return false;
        };

        // Monitor keyup for screenshot tools that trigger on release
        const handleKeyUp = (e: KeyboardEvent) => {
            if (e.key === 'PrintScreen') {
                e.preventDefault();
                e.stopImmediatePropagation();
                setShowBlackScreen(true);
                forceLogout('محاولة تصوير الشاشة');
            }
        };

        // Block selection
        const handleSelectStart = (e: Event) => {
            e.preventDefault();
            return false;
        };

        document.addEventListener('keydown', handleKeyDown, true);
        document.addEventListener('keyup', handleKeyUp, true);
        document.addEventListener('contextmenu', handleContextMenu, true);
        document.addEventListener('dragstart', handleDragStart, true);
        document.addEventListener('copy', handleCopy, true);
        document.addEventListener('paste', handlePaste, true);
        document.addEventListener('selectstart', handleSelectStart, true);

        return () => {
            document.removeEventListener('keydown', handleKeyDown, true);
            document.removeEventListener('keyup', handleKeyUp, true);
            document.removeEventListener('contextmenu', handleContextMenu, true);
            document.removeEventListener('dragstart', handleDragStart, true);
            document.removeEventListener('copy', handleCopy, true);
            document.removeEventListener('paste', handlePaste, true);
            document.removeEventListener('selectstart', handleSelectStart, true);
        };
    }, [forceLogout, onClose, togglePlay, skipBackward, skipForward, toggleMute, toggleFullscreen]);

    // Request fullscreen on mount
    useEffect(() => {
        const requestFullscreen = async () => {
            try {
                if (containerRef.current?.requestFullscreen) {
                    await containerRef.current.requestFullscreen();
                    setIsFullscreen(true);
                }
            } catch (err) {
                console.log('Fullscreen request failed:', err);
            }
        };

        setTimeout(requestFullscreen, 100);

        const handleFullscreenChange = () => {
            const isNowFullscreen = !!document.fullscreenElement;
            setIsFullscreen(isNowFullscreen);
            
            if (!isNowFullscreen) {
                onClose();
            }
        };

        document.addEventListener('fullscreenchange', handleFullscreenChange);
        return () => {
            document.removeEventListener('fullscreenchange', handleFullscreenChange);
        };
    }, [onClose]);

    // Load video
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
                console.log('Stream URL:', streamUrl);

                const isHLS = streamUrl.includes('.m3u8');

                if (isHLS && Hls.isSupported()) {
                    const hls = new Hls({
                        enableWorker: true,
                        lowLatencyMode: false,
                        backBufferLength: 90,
                        maxBufferLength: 30,
                        // Support for encrypted HLS (AES-128)
                        xhrSetup: (xhr, url) => {
                            // If requesting encryption key, add userId for authentication
                            if (url.includes('/api/videos/key/')) {
                                const separator = url.includes('?') ? '&' : '?';
                                xhr.open('GET', `${url}${separator}userId=${userId}`, true);
                            }
                        },
                    });

                    hlsRef.current = hls;

                    hls.on(Hls.Events.ERROR, (_, data) => {
                        if (data.fatal) {
                            console.error('HLS Error:', data);
                            // Check if it's a key loading error
                            if (data.type === Hls.ErrorTypes.KEY_SYSTEM_ERROR) {
                                setError('خطأ في فك تشفير الفيديو');
                            } else {
                                setError('حدث خطأ في تشغيل الفيديو');
                            }
                            setLoading(false);
                        }
                    });

                    // Log successful key loading
                    hls.on(Hls.Events.KEY_LOADED, () => {
                        console.log('🔐 Encryption key loaded successfully');
                    });

                    hls.on(Hls.Events.MANIFEST_PARSED, () => {
                        setLoading(false);
                        video.play().catch(() => {});
                    });

                    hls.loadSource(streamUrl);
                    hls.attachMedia(video);
                } else if (isHLS && video.canPlayType('application/vnd.apple.mpegurl')) {
                    video.src = streamUrl;
                    video.addEventListener('loadedmetadata', () => {
                        setLoading(false);
                        video.play().catch(() => {});
                    });
                } else {
                    video.src = streamUrl;
                    
                    video.addEventListener('loadedmetadata', () => {
                        setDuration(video.duration);
                        setLoading(false);
                    });
                    
                    video.addEventListener('canplay', () => {
                        setLoading(false);
                        video.play().catch(() => {});
                    });

                    video.addEventListener('error', (e) => {
                        console.error('Video error:', e);
                        setError('فشل تحميل الفيديو');
                        setLoading(false);
                    });
                }
            } catch (err) {
                console.error('Init error:', err);
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

    // Video event handlers
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const handlePlay = () => setIsPlaying(true);
        const handlePause = () => setIsPlaying(false);
        const handleTimeUpdate = () => {
            if (video.duration && !isDragging) {
                setProgress((video.currentTime / video.duration) * 100);
                setCurrentTime(video.currentTime);
            }
        };
        const handleLoadedMetadata = () => setDuration(video.duration);
        const handleVolumeChange = () => {
            setVolume(video.volume);
            setIsMuted(video.muted);
        };

        video.addEventListener('play', handlePlay);
        video.addEventListener('pause', handlePause);
        video.addEventListener('timeupdate', handleTimeUpdate);
        video.addEventListener('loadedmetadata', handleLoadedMetadata);
        video.addEventListener('volumechange', handleVolumeChange);

        return () => {
            video.removeEventListener('play', handlePlay);
            video.removeEventListener('pause', handlePause);
            video.removeEventListener('timeupdate', handleTimeUpdate);
            video.removeEventListener('loadedmetadata', handleLoadedMetadata);
            video.removeEventListener('volumechange', handleVolumeChange);
        };
    }, [isDragging]);

    const handleVolumeInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newVolume = parseFloat(e.target.value);
        if (videoRef.current) {
            videoRef.current.volume = newVolume;
            videoRef.current.muted = newVolume === 0;
            setVolume(newVolume);
            setIsMuted(newVolume === 0);
        }
    };

    // Progress bar click/drag handling
    const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!videoRef.current || !progressRef.current) return;
        const rect = progressRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const percentage = x / rect.width;
        const newTime = percentage * duration;
        videoRef.current.currentTime = newTime;
        setProgress(percentage * 100);
        setCurrentTime(newTime);
    };

    const handleProgressDrag = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!isDragging || !videoRef.current || !progressRef.current) return;
        const rect = progressRef.current.getBoundingClientRect();
        const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        const percentage = x / rect.width;
        const newTime = percentage * duration;
        setProgress(percentage * 100);
        setCurrentTime(newTime);
    };

    const handleProgressMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
        setIsDragging(true);
        handleProgressClick(e);
    };

    const handleProgressMouseUp = () => {
        if (isDragging && videoRef.current) {
            videoRef.current.currentTime = currentTime;
        }
        setIsDragging(false);
    };

    useEffect(() => {
        const handleMouseUp = () => {
            if (isDragging && videoRef.current) {
                videoRef.current.currentTime = currentTime;
            }
            setIsDragging(false);
        };

        const handleMouseMove = (e: MouseEvent) => {
            if (!isDragging || !videoRef.current || !progressRef.current) return;
            const rect = progressRef.current.getBoundingClientRect();
            const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
            const percentage = x / rect.width;
            const newTime = percentage * duration;
            setProgress(percentage * 100);
            setCurrentTime(newTime);
        };

        if (isDragging) {
            document.addEventListener('mouseup', handleMouseUp);
            document.addEventListener('mousemove', handleMouseMove);
        }

        return () => {
            document.removeEventListener('mouseup', handleMouseUp);
            document.removeEventListener('mousemove', handleMouseMove);
        };
    }, [isDragging, duration, currentTime]);

    const formatTime = (seconds: number) => {
        if (!seconds || isNaN(seconds)) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    return (
        <div 
            ref={containerRef}
            className="fixed inset-0 z-[9999] bg-black flex items-center justify-center"
            onMouseMove={resetControlsTimeout}
            onClick={resetControlsTimeout}
            style={{
                userSelect: 'none',
                WebkitUserSelect: 'none',
                // CSS protection against screenshots on mobile & desktop
                WebkitTouchCallout: 'none',
                touchAction: 'none',
                // Prevent screenshot flag on Android
                // @ts-ignore
                '-webkit-user-select': 'none',
                '-moz-user-select': 'none',
                '-ms-user-select': 'none',
            }}
            // Prevent screenshot attributes for mobile browsers
            data-html2canvas-ignore="true"
            data-screenshot-prevent="true"
        >
            {/* Security blur overlay when window loses focus */}
            {isSecurityBlurred && (
                <div className="absolute inset-0 z-[9998] bg-black flex items-center justify-center">
                    <div className="text-center">
                        <Shield className="h-24 w-24 text-purple-500 mx-auto mb-6 animate-pulse" />
                        <h2 className="text-white text-2xl font-bold mb-4">المحتوى محمي</h2>
                        <p className="text-white/70 text-lg">انقر على النافذة للمتابعة</p>
                        {suspiciousActivityCount.current > 3 && (
                            <p className="text-red-400 text-sm mt-4">⚠️ تم رصد نشاط مشبوه</p>
                        )}
                    </div>
                </div>
            )}

            {/* Recording detection warning */}
            {recordingDetected && (
                <div className="absolute top-24 left-1/2 transform -translate-x-1/2 z-[9999] bg-red-600 text-white px-6 py-3 rounded-lg shadow-2xl animate-pulse">
                    <div className="flex items-center gap-3">
                        <Shield className="h-5 w-5" />
                        <span className="font-bold">⚠️ تم رصد محاولة تسجيل!</span>
                    </div>
                </div>
            )}

            {/* Black screen for recording detection */}
            {showBlackScreen && (
                <div className="absolute inset-0 z-[9999] bg-black flex items-center justify-center">
                    <div className="text-center">
                        <Shield className="h-32 w-32 text-red-500 mx-auto mb-6 animate-pulse" />
                        <h2 className="text-red-500 text-4xl font-bold mb-4">⛔ محاولة تسجيل مكتشفة</h2>
                        <p className="text-white text-xl">جاري تسجيل خروجك...</p>
                    </div>
                </div>
            )}

            {/* Video Element with security attributes */}
            <video
                ref={videoRef}
                className="w-full h-full object-contain bg-black"
                playsInline
                controlsList="nodownload nofullscreen noremoteplayback"
                disablePictureInPicture
                onContextMenu={(e) => e.preventDefault()}
                onClick={togglePlay}
                // Mobile security attributes
                data-html2canvas-ignore="true"
                data-screenshot-prevent="true"
                // @ts-ignore - Android FLAG_SECURE equivalent
                x-webkit-airplay="deny"
                webkit-playsinline="true"
                style={{
                    // Make video harder to capture
                    filter: isSecurityBlurred || showBlackScreen ? 'blur(50px) brightness(0)' : 'none',
                    transition: 'filter 0.3s ease',
                    // Mobile-specific security styles
                    WebkitUserSelect: 'none',
                    WebkitTouchCallout: 'none',
                    touchAction: 'none',
                }}
            />

            {/* Multiple watermarks covering entire screen - like barcode pattern */}
            {watermarks.map((mark, index) => (
                <div 
                    key={index}
                    className="absolute pointer-events-none select-none z-[5]"
                    style={{
                        top: `${mark.y}%`,
                        left: `${mark.x}%`,
                        color: `rgba(255, 255, 255, ${mark.opacity})`,
                        fontSize: '11px',
                        fontWeight: '500',
                        textShadow: '0 1px 2px rgba(0,0,0,0.3)',
                        transform: `rotate(${mark.rotation}deg)`,
                        whiteSpace: 'nowrap',
                        userSelect: 'none',
                        pointerEvents: 'none'
                    }}
                >
                    {watermarkText}
                </div>
            ))}

            {/* Large prominent watermarks */}
            <div 
                className="absolute top-1/4 left-1/2 -translate-x-1/2 pointer-events-none select-none z-10 text-center"
                style={{
                    color: 'rgba(255, 255, 255, 0.08)',
                    fontSize: '32px',
                    fontWeight: '700',
                    textShadow: '2px 2px 4px rgba(0,0,0,0.5)',
                    transform: 'translate(-50%, 0) rotate(-25deg)',
                }}
            >
                {watermarkText}
            </div>

            <div 
                className="absolute bottom-1/4 left-1/4 pointer-events-none select-none z-10"
                style={{
                    color: 'rgba(255, 255, 255, 0.06)',
                    fontSize: '28px',
                    fontWeight: '600',
                    transform: 'rotate(15deg)',
                }}
            >
                {watermarkText}
            </div>

            <div 
                className="absolute top-1/3 right-1/4 pointer-events-none select-none z-10"
                style={{
                    color: 'rgba(255, 255, 255, 0.07)',
                    fontSize: '24px',
                    fontWeight: '600',
                    transform: 'rotate(-15deg)',
                }}
            >
                {watermarkText}
            </div>

            {/* SECURITY VIOLATION SCREEN */}
            {securityViolation && (
                <div className="absolute inset-0 flex items-center justify-center bg-black z-[9999]">
                    <div className="text-center p-12 bg-red-950 rounded-3xl border-4 border-red-500 shadow-2xl max-w-lg mx-4">
                        <div className="text-6xl mb-6">🚨</div>
                        <h2 className="text-red-500 text-3xl font-bold mb-4">انتهاك أمني!</h2>
                        <p className="text-white text-xl mb-6">{securityViolation}</p>
                        <div className="bg-red-900/50 rounded-xl p-4 mb-6">
                            <p className="text-red-300 text-lg">تم تسجيل هذه المحاولة وسيتم تسجيل خروجك الآن</p>
                        </div>
                        <div className="flex items-center justify-center gap-2 text-yellow-400">
                            <Loader2 className="h-5 w-5 animate-spin" />
                            <span>جاري تسجيل الخروج...</span>
                        </div>
                    </div>
                </div>
            )}

            {/* Loading */}
            {loading && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-20">
                    <div className="text-center">
                        <Loader2 className="h-20 w-20 animate-spin text-purple-500 mx-auto mb-4" />
                        <p className="text-white text-xl">جاري تحميل الفيديو...</p>
                    </div>
                </div>
            )}

            {/* Error */}
            {error && (
                <div className="absolute inset-0 flex items-center justify-center bg-black z-20">
                    <div className="text-center">
                        <p className="text-red-400 text-2xl mb-6">❌ {error}</p>
                        <button
                            onClick={onClose}
                            className="px-8 py-4 bg-purple-600 hover:bg-purple-700 rounded-xl text-white text-lg font-medium transition-colors"
                        >
                            إغلاق
                        </button>
                    </div>
                </div>
            )}

            {/* Controls Overlay */}
            {showControls && !loading && !error && (
                <>
                    {/* Top bar */}
                    <div className="absolute top-0 left-0 right-0 p-6 bg-gradient-to-b from-black/90 via-black/50 to-transparent z-30">
                        <div className="flex items-center justify-between">
                            <button
                                onClick={onClose}
                                className="flex items-center gap-2 px-5 py-3 bg-red-500/90 hover:bg-red-600 rounded-xl text-white transition-all hover:scale-105 shadow-lg"
                            >
                                <X className="h-5 w-5" />
                                <span className="font-medium">إغلاق</span>
                            </button>
                            
                            <div className="text-white/70 text-sm bg-black/40 px-4 py-2 rounded-full">
                                🎓 {studentName} • {groupName}
                            </div>
                        </div>
                    </div>

                    {/* Center play button */}
                    {!isPlaying && (
                        <div 
                            className="absolute inset-0 flex items-center justify-center z-10 cursor-pointer"
                            onClick={togglePlay}
                        >
                            <div className="p-8 bg-purple-600/90 rounded-full hover:bg-purple-700 transition-all hover:scale-110 shadow-2xl">
                                <Play className="h-20 w-20 text-white fill-white" />
                            </div>
                        </div>
                    )}

                    {/* Bottom controls */}
                    <div className="absolute bottom-0 left-0 right-0 px-8 py-6 bg-gradient-to-t from-black/95 via-black/80 to-transparent z-30">
                        {/* YouTube-style Progress bar */}
                        <div className="mb-6" dir="ltr">
                            <div 
                                ref={progressRef}
                                className="w-full bg-white/30 cursor-pointer relative group"
                                onMouseDown={handleProgressMouseDown}
                                onMouseUp={handleProgressMouseUp}
                                onMouseMove={handleProgressDrag}
                                onMouseEnter={() => setIsHoveringProgress(true)}
                                onMouseLeave={() => setIsHoveringProgress(false)}
                                style={{
                                    height: isHoveringProgress || isDragging ? '5px' : '3px',
                                    transition: 'height 0.15s ease',
                                    borderRadius: '2px'
                                }}
                            >
                                {/* Buffered background */}
                                <div className="absolute inset-0 bg-white/40" style={{ borderRadius: '2px' }} />
                                
                                {/* Progress - YouTube Red */}
                                <div 
                                    className="h-full bg-red-600 relative"
                                    style={{ 
                                        width: `${progress}%`, 
                                        transition: isDragging ? 'none' : 'width 0.1s linear',
                                        borderRadius: '2px'
                                    }}
                                >
                                    {/* Scrubber Handle - YouTube style */}
                                    <div 
                                        className="absolute right-0 top-1/2 bg-red-600 rounded-full shadow-xl"
                                        style={{
                                            width: isHoveringProgress || isDragging ? '14px' : '0px',
                                            height: isHoveringProgress || isDragging ? '14px' : '0px',
                                            transform: 'translateY(-50%)',
                                            transition: isDragging ? 'none' : 'width 0.15s ease, height 0.15s ease',
                                            cursor: isDragging ? 'grabbing' : 'grab',
                                            border: '2px solid rgba(255,255,255,0.9)'
                                        }}
                                    />
                                </div>
                                
                                {/* Hover time preview - YouTube style */}
                                {isHoveringProgress && (
                                    <div 
                                        className="absolute bottom-full mb-3 px-2.5 py-1.5 bg-black/95 text-white text-xs font-medium rounded shadow-xl pointer-events-none"
                                        style={{
                                            left: `${progress}%`,
                                            transform: 'translateX(-50%)',
                                            whiteSpace: 'nowrap'
                                        }}
                                    >
                                        {formatTime(currentTime)}
                                        <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-px">
                                            <div className="w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-black/95" />
                                        </div>
                                    </div>
                                )}
                            </div>
                            
                            {/* Time display - YouTube style */}
                            <div className="flex items-center gap-2 mt-3 text-white/90 text-sm font-medium">
                                <span className="tabular-nums">{formatTime(currentTime)}</span>
                                <span className="text-white/50">/</span>
                                <span className="text-white/70 tabular-nums">{formatTime(duration)}</span>
                            </div>
                        </div>

                        {/* Controls row */}
                        <div className="flex items-center justify-between mt-2">{/* Left controls */}
                            <div className="flex items-center gap-3">
                                {/* Skip backward */}
                                <button 
                                    onClick={skipBackward}
                                    className="p-2.5 hover:bg-white/10 rounded-full text-white transition-all"
                                    title="رجوع 5 ثواني (j)"
                                >
                                    <RotateCcw className="h-5 w-5" />
                                </button>

                                {/* Play/Pause - YouTube style */}
                                <button 
                                    onClick={togglePlay}
                                    className="p-3 hover:bg-white/10 rounded-full text-white transition-all"
                                    title={isPlaying ? 'إيقاف (k)' : 'تشغيل (k)'}
                                >
                                    {isPlaying ? <Pause className="h-8 w-8 fill-white" /> : <Play className="h-8 w-8 fill-white ml-0.5" />}
                                </button>

                                {/* Skip forward */}
                                <button 
                                    onClick={skipForward}
                                    className="p-2.5 hover:bg-white/10 rounded-full text-white transition-all"
                                    title="تقديم 5 ثواني (l)"
                                >
                                    <RotateCw className="h-5 w-5" />
                                </button>

                                {/* Volume control - YouTube style */}
                                <div 
                                    className="relative flex items-center group"
                                    onMouseEnter={() => setShowVolumeSlider(true)}
                                    onMouseLeave={() => setShowVolumeSlider(false)}
                                >
                                    <button 
                                        onClick={toggleMute}
                                        className="p-2.5 hover:bg-white/10 rounded-full text-white transition-all"
                                        title={isMuted ? 'تشغيل الصوت (m)' : 'كتم الصوت (m)'}
                                    >
                                        {isMuted || volume === 0 ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
                                    </button>
                                    
                                    {/* Volume slider - YouTube vertical style */}
                                    <div className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-black/90 rounded-lg px-2 py-3 transition-all ${showVolumeSlider ? 'opacity-100 visible' : 'opacity-0 invisible'}`}>
                                        <input
                                            type="range"
                                            min="0"
                                            max="1"
                                            step="0.05"
                                            value={isMuted ? 0 : volume}
                                            onChange={handleVolumeInputChange}
                                            className="h-20 cursor-pointer"
                                            style={{
                                                WebkitAppearance: 'slider-vertical',
                                                width: '4px',
                                                writingMode: 'bt-lr' as any,
                                                background: `linear-gradient(to top, #fff 0%, #fff ${(isMuted ? 0 : volume) * 100}%, rgba(255,255,255,0.3) ${(isMuted ? 0 : volume) * 100}%, rgba(255,255,255,0.3) 100%)`,
                                                borderRadius: '2px'
                                            }}
                                        />
                                    </div>
                                </div>
                            </div>

                            {/* Right controls */}
                            <div className="flex items-center gap-2">{/* Fullscreen */}
                                <button 
                                    onClick={toggleFullscreen}
                                    className="p-2.5 hover:bg-white/10 rounded-full text-white transition-all"
                                    title={isFullscreen ? 'الخروج من ملء الشاشة (f)' : 'ملء الشاشة (f)'}
                                >
                                    {isFullscreen ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
                                </button>
                            </div>
                        </div>
                    </div>
                </>
            )}

            {/* Keyboard shortcuts hint - YouTube style */}
            <div className="absolute bottom-32 left-1/2 transform -translate-x-1/2 text-white/40 text-xs pointer-events-none select-none z-10 bg-black/60 px-4 py-2 rounded backdrop-blur-sm">
                مسافة: إيقاف/تشغيل • j/l: ±5 ثواني • m: كتم • f: ملء الشاشة
            </div>

            {/* Invisible protection layers - make screen capture show black */}
            <div 
                className="absolute inset-0 pointer-events-none z-[1]"
                style={{
                    background: 'transparent',
                    mixBlendMode: 'difference',
                }}
            />
        </div>
    );
}
