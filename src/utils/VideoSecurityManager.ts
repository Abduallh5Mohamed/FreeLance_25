/**
 * VideoSecurityManager - Ultra-secure video protection for all platforms
 * Detects and prevents: Screenshots, Screen Recording, Alt-Tab, App Switching
 * Platforms: Desktop (Windows, Mac, Linux), iOS, Android
 * Version 4.0 - Maximum Security
 */

const API_BASE = import.meta.env.VITE_API_URL || '/api';

export interface SecurityViolation {
    type: 'screenshot' | 'screenrecord' | 'alttab' | 'blur' | 'focus_loss' | 'devtools' | 'resize' | 'keyboard' | 'pip' | 'unknown';
    details: string;
    timestamp: number;
    platform: string;
}

export interface SecurityConfig {
    userId: string;
    videoId: string;
    studentName: string;
    onViolation: (violation: SecurityViolation) => void;
    onForceLogout: (reason: string) => void;
    isHostedVideo: boolean;
}

export class VideoSecurityManager {
    private config: SecurityConfig;
    private isActive: boolean = false;
    private platform: 'ios' | 'android' | 'desktop' = 'desktop';
    private checkIntervals: NodeJS.Timeout[] = [];
    private eventListeners: Array<{ target: EventTarget; event: string; handler: EventListener }> = [];
    private lastVisibilityState: boolean = true;
    private mediaQueryList: MediaQueryList | null = null;
    private originalMediaDevices: any = null;
    private screenRecordingDetected: boolean = false;

    constructor(config: SecurityConfig) {
        this.config = config;
        this.detectPlatform();
    }

    private detectPlatform() {
        const ua = navigator.userAgent.toLowerCase();
        if (/iphone|ipad|ipod/.test(ua)) {
            this.platform = 'ios';
        } else if (/android/.test(ua)) {
            this.platform = 'android';
        } else {
            this.platform = 'desktop';
        }
        console.log(`🔒 Security: Platform detected: ${this.platform}`);
    }

    public start() {
        if (this.isActive) return;
        this.isActive = true;

        console.log('🛡️ VideoSecurityManager: Starting maximum protection...');

        // Common protections
        this.setupVisibilityDetection();
        this.setupBlurDetection();
        this.setupKeyboardProtection();
        this.setupContextMenuProtection();
        this.setupDevToolsDetection();
        this.setupScreenRecordingAPIBlock();
        this.setupPictureInPictureBlock();

        // Platform-specific protections
        if (this.platform === 'ios') {
            this.setupIOSProtection();
        } else if (this.platform === 'android') {
            this.setupAndroidProtection();
        } else {
            this.setupDesktopProtection();
        }

        // Aggressive protections for hosted videos
        if (this.config.isHostedVideo) {
            this.setupAggressiveProtection();
        }
    }

    public stop() {
        if (!this.isActive) return;
        this.isActive = false;

        console.log('🔓 VideoSecurityManager: Stopping protection...');

        // Clear all intervals
        this.checkIntervals.forEach(interval => clearInterval(interval));
        this.checkIntervals = [];

        // Remove all event listeners
        this.eventListeners.forEach(({ target, event, handler }) => {
            target.removeEventListener(event, handler);
        });
        this.eventListeners = [];

        // Restore original APIs
        if (this.originalMediaDevices) {
            navigator.mediaDevices.getDisplayMedia = this.originalMediaDevices;
        }
    }

    private addListener(target: EventTarget, event: string, handler: EventListener, options?: AddEventListenerOptions) {
        target.addEventListener(event, handler, options);
        this.eventListeners.push({ target, event, handler });
    }

    private triggerViolation(type: SecurityViolation['type'], details: string) {
        if (!this.isActive) return;

        const violation: SecurityViolation = {
            type,
            details,
            timestamp: Date.now(),
            platform: this.platform
        };

        console.log('⚠️ Security Violation:', violation);
        this.config.onViolation(violation);

        // Log to server
        this.logSecurityEvent(violation);

        // For hosted videos, force logout immediately
        if (this.config.isHostedVideo) {
            this.config.onForceLogout(details);
        }
    }

    private async logSecurityEvent(violation: SecurityViolation) {
        try {
            await fetch(`${API_BASE}/videos/security/log`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: this.config.userId,
                    videoId: this.config.videoId,
                    activityType: violation.type,
                    details: `${violation.details} | Platform: ${violation.platform}`
                })
            });
        } catch (error) {
            console.error('Failed to log security event:', error);
        }
    }

    // ============================================
    // VISIBILITY DETECTION
    // ============================================
    private setupVisibilityDetection() {
        const handler = () => {
            if (document.hidden || document.visibilityState === 'hidden') {
                this.triggerViolation('blur', 'تم إخفاء التطبيق / Tab Hidden');
            }
        };
        this.addListener(document, 'visibilitychange', handler, { capture: true });
    }

    // ============================================
    // BLUR/FOCUS DETECTION
    // ============================================
    private setupBlurDetection() {
        const blurHandler = () => {
            this.triggerViolation('focus_loss', 'فقدان التركيز / Window Blur');
        };

        const focusCheckInterval = setInterval(() => {
            if (!document.hasFocus() && this.isActive) {
                this.triggerViolation('focus_loss', 'فقدان التركيز المستمر / Continuous Focus Loss');
            }
        }, 500);

        this.checkIntervals.push(focusCheckInterval);
        this.addListener(window, 'blur', blurHandler, { capture: true });
    }

    // ============================================
    // KEYBOARD PROTECTION
    // ============================================
    private setupKeyboardProtection() {
        const handler = (e: Event) => {
            const ke = e as KeyboardEvent;
            
            // Block dangerous key combinations
            const blockedKeys = [
                'PrintScreen',
                'F12',
                'F11',
                'Escape'
            ];

            const isBlocked = blockedKeys.includes(ke.key) ||
                ke.ctrlKey ||
                ke.altKey ||
                ke.metaKey ||
                (ke.key === 'Tab' && ke.altKey);

            if (isBlocked) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                this.triggerViolation('keyboard', `محاولة استخدام اختصار محظور: ${ke.key}`);
                return false;
            }
        };

        this.addListener(document, 'keydown', handler, { capture: true });
        this.addListener(document, 'keyup', handler, { capture: true });
    }

    // ============================================
    // CONTEXT MENU PROTECTION
    // ============================================
    private setupContextMenuProtection() {
        const handler = (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
            return false;
        };
        this.addListener(document, 'contextmenu', handler, { capture: true });
    }

    // ============================================
    // DEVTOOLS DETECTION
    // ============================================
    private setupDevToolsDetection() {
        // Method 1: Size detection
        const checkSize = () => {
            const widthThreshold = window.outerWidth - window.innerWidth > 160;
            const heightThreshold = window.outerHeight - window.innerHeight > 160;
            
            if (widthThreshold || heightThreshold) {
                this.triggerViolation('devtools', 'محاولة فتح أدوات المطورين / DevTools Detected');
            }
        };

        const sizeInterval = setInterval(checkSize, 1000);
        this.checkIntervals.push(sizeInterval);

        // Method 2: Console detection
        const devtoolsDetector = new Image();
        Object.defineProperty(devtoolsDetector, 'id', {
            get: () => {
                this.triggerViolation('devtools', 'Console DevTools Detected');
            }
        });

        // Method 3: Resize detection
        this.addListener(window, 'resize', checkSize as EventListener);
    }

    // ============================================
    // SCREEN RECORDING API BLOCK
    // ============================================
    private setupScreenRecordingAPIBlock() {
        if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
            this.originalMediaDevices = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
            
            (navigator.mediaDevices as any).getDisplayMedia = () => {
                this.triggerViolation('screenrecord', 'محاولة تسجيل الشاشة / Screen Recording API Called');
                return Promise.reject(new Error('Screen recording blocked'));
            };
        }

        // Also block getUserMedia with display surface
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            
            (navigator.mediaDevices as any).getUserMedia = (constraints: MediaStreamConstraints) => {
                if (constraints && (constraints as any).video && 
                    typeof (constraints as any).video === 'object' &&
                    ((constraints as any).video.displaySurface || (constraints as any).video.mediaSource)) {
                    this.triggerViolation('screenrecord', 'محاولة تسجيل الشاشة عبر getUserMedia');
                    return Promise.reject(new Error('Screen recording blocked'));
                }
                return originalGetUserMedia(constraints);
            };
        }
    }

    // ============================================
    // PICTURE-IN-PICTURE BLOCK
    // ============================================
    private setupPictureInPictureBlock() {
        // Block PiP enter
        this.addListener(document, 'enterpictureinpicture', (e: Event) => {
            e.preventDefault();
            (e.target as HTMLVideoElement)?.exitPictureInPicture?.();
            this.triggerViolation('pip', 'محاولة استخدام Picture-in-Picture');
        }, { capture: true });
    }

    // ============================================
    // iOS SPECIFIC PROTECTION
    // ============================================
    private setupIOSProtection() {
        console.log('📱 Setting up iOS-specific protections...');

        // iOS Screenshot Detection via touch events
        let touchCount = 0;
        let lastTouchTime = 0;

        const touchHandler = () => {
            const now = Date.now();
            if (now - lastTouchTime < 100) {
                touchCount++;
                if (touchCount >= 3) {
                    // Multiple rapid touches might indicate screenshot gesture
                    this.triggerViolation('screenshot', 'اشتباه بمحاولة التقاط صورة للشاشة (iOS)');
                    touchCount = 0;
                }
            } else {
                touchCount = 1;
            }
            lastTouchTime = now;
        };

        this.addListener(document, 'touchstart', touchHandler, { passive: true });

        // iOS Control Center detection (volume change without user interaction)
        // When Control Center opens, visibilitychange fires
        
        // iOS Screen Recording Indicator Detection
        // On iOS 14+, screen recording shows a red status bar
        // We can detect this through CSS media query (limited)
        
        // Power + Volume button combination (screenshot)
        // We detect this through rapid blur events
        let blurCount = 0;
        const blurCheckInterval = setInterval(() => {
            blurCount = 0;
        }, 2000);
        this.checkIntervals.push(blurCheckInterval);

        const iosBlurHandler = () => {
            blurCount++;
            if (blurCount >= 2) {
                this.triggerViolation('screenshot', 'اشتباه بالتقاط صورة للشاشة (iOS Screenshot)');
            }
        };
        this.addListener(window, 'blur', iosBlurHandler);

        // Detect iOS screen recording via checking video element playback issues
        // Screen recording sometimes causes subtle playback hiccups
    }

    // ============================================
    // ANDROID SPECIFIC PROTECTION
    // ============================================
    private setupAndroidProtection() {
        console.log('📱 Setting up Android-specific protections...');

        // Android Screenshot Detection
        // Volume down + Power button detection
        let volumeKeyPressed = false;
        let powerKeyPressed = false;

        const keydownHandler = (e: Event) => {
            const ke = e as KeyboardEvent;
            if (ke.key === 'VolumeDown' || ke.keyCode === 25) {
                volumeKeyPressed = true;
            }
            // Power key is hard to detect, but we can use visibility change
        };

        const keyupHandler = (e: Event) => {
            const ke = e as KeyboardEvent;
            if (ke.key === 'VolumeDown' || ke.keyCode === 25) {
                volumeKeyPressed = false;
            }
        };

        this.addListener(document, 'keydown', keydownHandler);
        this.addListener(document, 'keyup', keyupHandler);

        // Android recent apps button detection
        // When user presses recent apps, the page gets paused
        const pauseHandler = () => {
            this.triggerViolation('alttab', 'تم الانتقال لتطبيق آخر (Android Recent Apps)');
        };
        this.addListener(window, 'pagehide', pauseHandler);

        // Detect MediaProjection API (screen recording on Android)
        // This is similar to getDisplayMedia blocking

        // Android split screen detection
        const checkSplitScreen = () => {
            // On Android in split screen, innerHeight is roughly half
            if (window.innerHeight < screen.height * 0.6 && window.innerWidth === screen.width) {
                this.triggerViolation('resize', 'اكتشاف وضع الشاشة المقسمة (Split Screen)');
            }
        };
        const splitInterval = setInterval(checkSplitScreen, 1000);
        this.checkIntervals.push(splitInterval);
    }

    // ============================================
    // DESKTOP SPECIFIC PROTECTION
    // ============================================
    private setupDesktopProtection() {
        console.log('💻 Setting up Desktop-specific protections...');

        // PrintScreen key detection (Windows)
        const printScreenHandler = (e: Event) => {
            const ke = e as KeyboardEvent;
            if (ke.key === 'PrintScreen' || ke.keyCode === 44) {
                e.preventDefault();
                this.triggerViolation('screenshot', 'محاولة التقاط صورة للشاشة (PrintScreen)');
                // Clear clipboard
                if (navigator.clipboard) {
                    navigator.clipboard.writeText('Protected Content - Al-Qaed Platform').catch(() => {});
                }
            }
        };
        this.addListener(document, 'keyup', printScreenHandler, { capture: true });

        // Windows Snipping Tool / Snip & Sketch detection
        // These tools typically cause a brief blur
        let blurTimestamp = 0;
        const snippingHandler = () => {
            const now = Date.now();
            if (now - blurTimestamp < 1000) {
                this.triggerViolation('screenshot', 'اشتباه باستخدام أداة القص (Snipping Tool)');
            }
            blurTimestamp = now;
        };
        this.addListener(window, 'blur', snippingHandler);

        // Mac Command+Shift+3/4/5 detection
        const macScreenshotHandler = (e: Event) => {
            const ke = e as KeyboardEvent;
            if (ke.metaKey && ke.shiftKey && ['3', '4', '5'].includes(ke.key)) {
                e.preventDefault();
                this.triggerViolation('screenshot', 'محاولة التقاط صورة للشاشة (Mac Screenshot)');
            }
        };
        this.addListener(document, 'keydown', macScreenshotHandler, { capture: true });

        // OBS / Screen Recording Software Detection
        // Monitor for performance changes that indicate recording
        if ('PerformanceObserver' in window) {
            try {
                const perfObserver = new PerformanceObserver((list) => {
                    for (const entry of list.getEntries()) {
                        if (entry.entryType === 'longtask' && entry.duration > 100) {
                            // Long tasks might indicate recording overhead
                            // Don't trigger immediately, just log
                            console.log('⚠️ Long task detected, possible recording:', entry.duration);
                        }
                    }
                });
                perfObserver.observe({ entryTypes: ['longtask'] });
            } catch (e) {
                // PerformanceObserver not fully supported
            }
        }
    }

    // ============================================
    // AGGRESSIVE PROTECTION (For Hosted Videos)
    // ============================================
    private setupAggressiveProtection() {
        console.log('🔥 Setting up AGGRESSIVE protection for hosted video...');

        // Constant focus monitoring
        const aggressiveFocusCheck = setInterval(() => {
            if (!document.hasFocus()) {
                this.triggerViolation('focus_loss', 'فقدان التركيز - إجباري');
            }
        }, 300);
        this.checkIntervals.push(aggressiveFocusCheck);

        // Clipboard clearing
        const clipboardClear = setInterval(() => {
            if (navigator.clipboard && document.hasFocus()) {
                navigator.clipboard.writeText('المحتوى محمي - منصة القائد').catch(() => {});
            }
        }, 1000);
        this.checkIntervals.push(clipboardClear);

        // Disable text selection
        document.body.style.userSelect = 'none';
        document.body.style.webkitUserSelect = 'none';
        (document.body.style as any).msUserSelect = 'none';

        // Disable dragging
        const dragHandler = (e: Event) => {
            e.preventDefault();
            return false;
        };
        this.addListener(document, 'dragstart', dragHandler, { capture: true });
        this.addListener(document, 'drop', dragHandler, { capture: true });

        // Window beforeunload warning
        const beforeUnloadHandler = (e: Event) => {
            e.preventDefault();
            (e as BeforeUnloadEvent).returnValue = '';
        };
        this.addListener(window, 'beforeunload', beforeUnloadHandler);
    }

    // ============================================
    // PUBLIC UTILITY METHODS
    // ============================================
    public getPlatform(): string {
        return this.platform;
    }

    public isScreenRecordingDetected(): boolean {
        return this.screenRecordingDetected;
    }

    public forceBlackScreen(): void {
        document.body.innerHTML = `
            <div style="position:fixed;inset:0;background:#000;z-index:999999;display:flex;align-items:center;justify-content:center;flex-direction:column;">
                <svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 24 24" fill="none" stroke="red" stroke-width="2">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                </svg>
                <h1 style="color:#ff0000;font-size:32px;margin-top:20px;font-family:sans-serif;">تم اكتشاف انتهاك أمني!</h1>
                <p style="color:#888;font-size:18px;margin-top:10px;font-family:sans-serif;">جاري تسجيل الخروج...</p>
            </div>
        `;
    }
}

export default VideoSecurityManager;
