/**
 * useSecuritySupervisor — Global React Hook
 * 
 * Continuously monitors for:
 * - DevTools open (multi-method detection)
 * - Debugger traps
 * - Console tampering  
 * - Window dimension inconsistencies
 * - Performance timing anomalies
 * - DOM mutation of player container
 * - Fullscreen exit
 * - Visibility change
 * - Multiple tab detection
 * - Abnormal playback speed/seek
 * - MediaRecorder/getDisplayMedia override
 * - Screen capture attempts
 *
 * On violation: pause, blur, report, kill session, force logout
 */
import { useEffect, useRef, useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { buildSecurityEventRequest } from '@/utils/VideoSecurityManager';

interface SecurityConfig {
    sessionId: string;
    sessionToken: string;
    videoId: string;
    userId: string;
    onViolation?: (type: string, details: string) => void;
    onSessionKilled?: () => void;
    containerRef?: React.RefObject<HTMLElement>;
    videoRef?: React.RefObject<HTMLVideoElement>;
}

interface ViolationReport {
    type: string;
    details: string;
    timestamp: number;
}

export interface VideoRestrictions {
    qualityCap: number | null;
    fullscreenAllowed: boolean;
    riskScore: number;
}

export function useSecuritySupervisor(config: SecurityConfig) {
    const navigate = useNavigate();
    const isKilledRef = useRef(false);
    const heartbeatRef = useRef<NodeJS.Timeout | null>(null);
    const violationsRef = useRef<ViolationReport[]>([]);
    const lastSeekRef = useRef<number>(0);
    const seekCountRef = useRef<number>(0);
    const sessionTokenRef = useRef(config.sessionToken);
    const domHashRef = useRef<string>('');
    const [isBlocked, setIsBlocked] = useState(false);
    const [restrictions, setRestrictions] = useState<VideoRestrictions>({ qualityCap: null, fullscreenAllowed: true, riskScore: 0 });

    // Update token ref when it changes
    useEffect(() => {
        sessionTokenRef.current = config.sessionToken;
    }, [config.sessionToken]);

    // ═══ FORCE LOGOUT ═══
    const forceLogout = useCallback(async (reason: string) => {
        if (isKilledRef.current) return;
        isKilledRef.current = true;

        console.error('🔴 SECURITY: Force logout -', reason);

        // Kill session on server
        try {
            if (config.sessionId) {
                const { url, init } = buildSecurityEventRequest('/secure-video/force-logout', {
                    sessionId: config.sessionId,
                    activityType: reason.includes('MediaRecorder') ? 'media_recorder_detected' : 'screen_capture_attempt',
                    details: reason
                });
                await fetch(url, init);
            }
        } catch (e) {
            console.error('[Security] Failed to kill session on server:', e);
        }

        // Clear all storage
        localStorage.removeItem('currentUser');
        localStorage.removeItem('authToken');
        localStorage.removeItem('currentStudent');
        localStorage.removeItem('currentStudentSpace');
        sessionStorage.clear();

        // Navigate to login
        config.onSessionKilled?.();
        navigate('/auth', { replace: true });
        window.location.reload();
    }, [config.sessionId, navigate, config.onSessionKilled]);

    // ═══ REPORT VIOLATION ═══
    const reportViolation = useCallback(async (type: string, details: string, confidence: 'low' | 'medium' | 'high' = 'medium'): Promise<boolean> => {
        if (isKilledRef.current) return false;

        violationsRef.current.push({ type, details, timestamp: Date.now() });
        config.onViolation?.(type, details);

        try {
            if (!config.sessionId) return false; // Skip in legacy mode
            const { url, init } = buildSecurityEventRequest('/secure-video/report-violation', {
                sessionId: config.sessionId,
                sessionToken: sessionTokenRef.current,
                violationType: type,
                details,
                confidence
            });
            const response = await fetch(url, init);
            const result = await response.json().catch(() => ({})) as Record<string, unknown>;

            if (!response.ok) {
                // Report failures honestly: a rejected report must not look delivered.
                console.error('[Security] Violation report rejected: HTTP', response.status);
                return false;
            }

            if (result.restrictions) setRestrictions(result.restrictions as VideoRestrictions);

            if (result.killed || result.suspended) {
                forceLogout(`Server killed session: ${type}`);
            }
            return true;
        } catch (e) {
            console.error('[Security] Failed to report violation:', e);
            return false;
        }
    }, [config.sessionId, forceLogout, config.onViolation]);

    // ═══ BLOCK SCREEN ═══
    const blockScreen = useCallback((reason: string, report = true) => {
        if (isKilledRef.current) return;
        setIsBlocked(true);
        config.videoRef?.current?.pause();
        if (report) reportViolation('screen_blocked', reason, 'low');
    }, [reportViolation, config.videoRef]);

    const unblockScreen = useCallback(() => {
        setIsBlocked(false);
        config.videoRef?.current?.play().catch(() => { });
    }, [config.videoRef]);

    useEffect(() => {
        if (isKilledRef.current) return;
        const cleanups: (() => void)[] = [];

        // Delay initialization to prevent false positives on mount
        const initTimer = setTimeout(() => {

            // ══════════════════════════════════════
            // 1. DEVTOOLS DETECTION (Multi-method)
            // ══════════════════════════════════════

            // Method A: Window size differential
            const devToolsInterval = setInterval(() => {
                const widthDiff = window.outerWidth - window.innerWidth;
                const heightDiff = window.outerHeight - window.innerHeight;
                if (widthDiff > 200 || heightDiff > 200) {
                    reportViolation('devtools_open', `Size diff: ${widthDiff}x${heightDiff}`);
                    blockScreen('تم اكتشاف أدوات المطور');
                }
            }, 3000);
            cleanups.push(() => clearInterval(devToolsInterval));

            // Method B: Performance timing (debugger step detection)
            const perfInterval = setInterval(() => {
                const start = performance.now();
                // This line detects if debugger is stepping through code
                (() => { })(); // no-op that takes measurably longer under debugger
                const elapsed = performance.now() - start;
                if (elapsed > 100) { // normal is <1ms, debugger makes it >100ms
                    reportViolation('debugger_detected', `Execution delay: ${elapsed}ms`);
                    blockScreen('تم اكتشاف مصحح الأخطاء');
                }
            }, 5000);
            cleanups.push(() => clearInterval(perfInterval));

            // Method C: Console tamper detection
            const originalLog = console.log;
            const consoleCheckInterval = setInterval(() => {
                if (console.log !== originalLog && console.log.toString() !== originalLog.toString()) {
                    reportViolation('console_tamper', 'console.log was overridden');
                }
            }, 10000);
            cleanups.push(() => clearInterval(consoleCheckInterval));

            // ══════════════════════════════════════
            // 2. VISIBILITY & FOCUS
            // ══════════════════════════════════════

            const handleVisibility = () => {
                if (document.hidden) {
                    blockScreen('تم إخفاء التبويب', false);
                    reportViolation('visibility_change', 'Document became hidden', 'low');
                }
            };
            document.addEventListener('visibilitychange', handleVisibility, true);
            cleanups.push(() => document.removeEventListener('visibilitychange', handleVisibility, true));

            // ══════════════════════════════════════
            // 3. KEYBOARD SHORTCUTS
            // ══════════════════════════════════════

            const handleKeyDown = (e: KeyboardEvent) => {
                const key = e.key?.toLowerCase();

                // PrintScreen → FORCE LOGOUT
                if (e.key === 'PrintScreen') {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    forceLogout('PrintScreen detected');
                    return;
                }

                // Win+Shift+S (Snipping Tool)
                if (e.metaKey && e.shiftKey && key === 's') {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    forceLogout('Screen capture shortcut detected: Win+Shift+S');
                    return;
                }

                // Win+G (Game Bar)
                if (e.metaKey && key === 'g') {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    forceLogout('Screen recorder shortcut detected: Win+G Game Bar');
                    return;
                }

                // Win+Alt+R (Game Bar record)
                if (e.metaKey && e.altKey && key === 'r') {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    forceLogout('Screen recorder shortcut detected: Win+Alt+R');
                    return;
                }

                // Mac screenshots: Cmd+Shift+3/4/5
                if (e.metaKey && e.shiftKey && ['3', '4', '5', '#', '$', '%'].includes(e.key)) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    forceLogout(`Screen capture shortcut detected: Cmd+Shift+${e.key}`);
                    return;
                }

                // DevTools shortcuts
                if (e.key === 'F12' ||
                    (e.ctrlKey && e.shiftKey && ['i', 'j', 'c'].includes(key)) ||
                    (e.ctrlKey && key === 'u')) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    reportViolation('devtools_open', `Shortcut: ${e.key}`);
                    return;
                }

                // Ctrl+P (Print), Ctrl+S (Save)
                if (e.ctrlKey && (key === 'p' || key === 's')) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    return;
                }
            };

            const handleKeyUp = (e: KeyboardEvent) => {
                if (e.key === 'PrintScreen') {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    // Immediately clear clipboard to destroy captured screenshot
                    try {
                        navigator.clipboard.writeText('').catch(() => { });
                    } catch (ex) { }
                    // Also try the older method
                    try {
                        document.execCommand('copy');
                    } catch (ex) { }
                }
            };

            window.addEventListener('keydown', handleKeyDown, true);
            window.addEventListener('keyup', handleKeyUp, true);
            cleanups.push(() => {
                window.removeEventListener('keydown', handleKeyDown, true);
                window.removeEventListener('keyup', handleKeyUp, true);
            });

            // ══════════════════════════════════════
            // 4. CONTEXT MENU, COPY, DRAG
            // ══════════════════════════════════════

            const blockEvent = (e: Event) => { e.preventDefault(); };
            const blockCopy = (e: ClipboardEvent) => {
                e.preventDefault();
                if (e.clipboardData) e.clipboardData.setData('text/plain', '');
            };

            document.addEventListener('contextmenu', blockEvent, true);
            document.addEventListener('dragstart', blockEvent, true);
            document.addEventListener('copy', blockCopy, true);
            document.addEventListener('cut', blockCopy, true);
            cleanups.push(() => {
                document.removeEventListener('contextmenu', blockEvent, true);
                document.removeEventListener('dragstart', blockEvent, true);
                document.removeEventListener('copy', blockCopy, true);
                document.removeEventListener('cut', blockCopy, true);
            });

            // ══════════════════════════════════════
            // 5. OVERRIDE SCREEN CAPTURE APIs
            // ══════════════════════════════════════

            if (navigator.mediaDevices) {
                const origGetDisplayMedia = navigator.mediaDevices.getDisplayMedia;
                const origGetUserMedia = navigator.mediaDevices.getUserMedia?.bind(navigator.mediaDevices);

                try {
                    // @ts-ignore
                    navigator.mediaDevices.getDisplayMedia = () => {
                        forceLogout('Screen Capture API getDisplayMedia detected');
                        return Promise.reject(new Error('Screen capture blocked'));
                    };
                } catch { /* Some mobile browsers expose a read-only method. */ }

                // @ts-ignore
                navigator.mediaDevices.getUserMedia = (constraints: MediaStreamConstraints) => {
                    const videoConstraints = constraints?.video && typeof constraints.video === 'object'
                        ? constraints.video as MediaTrackConstraints & { mediaSource?: string }
                        : undefined;
                    if (videoConstraints?.mediaSource === 'screen' ||
                        videoConstraints?.mediaSource === 'window') {
                        forceLogout('Screen capture through getUserMedia detected');
                        return Promise.reject(new Error('Screen capture blocked'));
                    }
                    return origGetUserMedia ? origGetUserMedia(constraints) : Promise.reject();
                };

                cleanups.push(() => {
                    if (origGetDisplayMedia) {
                        // @ts-ignore
                        navigator.mediaDevices.getDisplayMedia = origGetDisplayMedia;
                    }
                    if (origGetUserMedia) {
                        // @ts-ignore
                        navigator.mediaDevices.getUserMedia = origGetUserMedia;
                    }
                });
            }

            // Override MediaRecorder
            const OrigMediaRecorder = window.MediaRecorder;
            if (OrigMediaRecorder) {
                // @ts-ignore
                window.MediaRecorder = class FakeMediaRecorder {
                    constructor() {
                        reportViolation('media_recorder_detected', 'MediaRecorder instantiated');
                        forceLogout('MediaRecorder detected');
                        throw new Error('MediaRecorder is not allowed');
                    }
                };
                cleanups.push(() => {
                    // @ts-ignore
                    window.MediaRecorder = OrigMediaRecorder;
                });
            }

            // Block in-page extraction of decoded frames through captureStream.
            const mediaPrototype = HTMLMediaElement.prototype as HTMLMediaElement & {
                captureStream?: (...args: unknown[]) => MediaStream;
                mozCaptureStream?: (...args: unknown[]) => MediaStream;
            };
            const canvasPrototype = HTMLCanvasElement.prototype;
            const originalMediaCapture = mediaPrototype.captureStream;
            const originalMozCapture = mediaPrototype.mozCaptureStream;
            const originalCanvasCapture = canvasPrototype.captureStream;
            const rejectFrameCapture = () => {
                forceLogout('Decoded media captureStream detected');
                throw new DOMException('Media capture is blocked', 'NotAllowedError');
            };
            try {
                if (originalMediaCapture) mediaPrototype.captureStream = rejectFrameCapture;
                if (originalMozCapture) mediaPrototype.mozCaptureStream = rejectFrameCapture;
                if (originalCanvasCapture) canvasPrototype.captureStream = rejectFrameCapture;
                cleanups.push(() => {
                    if (originalMediaCapture) mediaPrototype.captureStream = originalMediaCapture;
                    if (originalMozCapture) mediaPrototype.mozCaptureStream = originalMozCapture;
                    if (originalCanvasCapture) canvasPrototype.captureStream = originalCanvasCapture;
                });
            } catch { /* Prototype may be locked down by the browser. */ }

            // ══════════════════════════════════════
            // 6. DOM MUTATION MONITORING
            // ══════════════════════════════════════

            if (config.containerRef?.current) {
                const observer = new MutationObserver((mutations) => {
                    for (const m of mutations) {
                        // Check if someone injected elements into the player
                        if (m.type === 'childList' && m.addedNodes.length > 0) {
                            for (const node of Array.from(m.addedNodes)) {
                                if (node instanceof HTMLElement) {
                                    const tag = node.tagName.toLowerCase();
                                    // Allow canvas, video, known elements
                                    if (!['canvas', 'video', 'div', 'button', 'span', 'svg', 'path', 'style', 'iframe'].includes(tag)) {
                                        reportViolation('dom_mutation', `Unknown element injected: <${tag}>`);
                                    }
                                }
                            }
                        }
                        // Check attribute changes on video element
                        if (m.type === 'attributes' && m.target instanceof HTMLVideoElement) {
                            if (m.attributeName === 'src' || m.attributeName === 'srcObject') {
                                reportViolation('dom_mutation', `Video ${m.attributeName} changed`);
                            }
                        }
                    }
                });

                observer.observe(config.containerRef.current, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ['src', 'srcObject', 'style']
                });
                cleanups.push(() => observer.disconnect());
            }

            // ══════════════════════════════════════
            // 7. MULTIPLE TAB DETECTION
            // ══════════════════════════════════════

            const tabChannel = new BroadcastChannel('tabweb_academy_video_session');
            tabChannel.postMessage({ type: 'new_tab', sessionId: config.sessionId });

            tabChannel.onmessage = (event) => {
                if (event.data.type === 'new_tab' && event.data.sessionId !== config.sessionId) {
                    reportViolation('multi_tab', 'Video opened in another tab', 'medium');
                    blockScreen('تم فتح الفيديو في تبويب آخر');
                }
            };
            cleanups.push(() => tabChannel.close());

            // ══════════════════════════════════════
            // 8. ABNORMAL PLAYBACK DETECTION
            // ══════════════════════════════════════

            if (config.videoRef?.current) {
                const vidEl = config.videoRef.current;

                const handleRateChange = () => {
                    if (vidEl.playbackRate !== 1) {
                        vidEl.playbackRate = 1;
                        reportViolation('abnormal_playback', `Speed changed to ${vidEl.playbackRate}`);
                    }
                };

                const handleSeeking = () => {
                    const now = Date.now();
                    if (now - lastSeekRef.current < 2000) {
                        seekCountRef.current++;
                        if (seekCountRef.current > 5) {
                            reportViolation('abnormal_playback', `Rapid seeking detected (${seekCountRef.current} seeks)`);
                            seekCountRef.current = 0;
                        }
                    } else {
                        seekCountRef.current = 1;
                    }
                    lastSeekRef.current = now;
                };

                vidEl.addEventListener('ratechange', handleRateChange);
                vidEl.addEventListener('seeking', handleSeeking);
                cleanups.push(() => {
                    vidEl.removeEventListener('ratechange', handleRateChange);
                    vidEl.removeEventListener('seeking', handleSeeking);
                });
            }

            // ══════════════════════════════════════
            // 9. TOUCH SCREENSHOT DETECTION (Mobile)
            // ══════════════════════════════════════

            const handleTouchStart = (e: TouchEvent) => {
                if (e.touches.length >= 3) {
                    blockScreen('اكتشاف محاولة التقاط');
                    reportViolation('screen_capture_attempt', '3+ finger touch');
                }
            };
            window.addEventListener('touchstart', handleTouchStart, { passive: true, capture: true });
            cleanups.push(() => window.removeEventListener('touchstart', handleTouchStart, true));

            // ══════════════════════════════════════
            // 10. CSS PROTECTION
            // ══════════════════════════════════════

            const style = document.createElement('style');
            style.id = 'security-supervisor-styles';
            style.textContent = `
                .secure-video-container, .secure-video-container * {
                    -webkit-user-select: none !important;
                    user-select: none !important;
                    -webkit-touch-callout: none !important;
                }
                .secure-video-container img, .secure-video-container video, .secure-video-container canvas {
                    -webkit-user-drag: none !important;
                    user-drag: none !important;
                }
                .secure-video-container video { pointer-events: auto !important; }
                @media print {
                    .secure-video-container, .secure-video-container * {
                        display: none !important;
                        visibility: hidden !important;
                    }
                    body::after {
                        content: 'طباعة المحتوى غير مسموحة' !important;
                        display: block !important;
                        font-size: 48px !important;
                        text-align: center !important;
                        padding-top: 200px !important;
                        color: red !important;
                    }
                }
            `;
            document.head.appendChild(style);
            cleanups.push(() => style.remove());

            // Override window.print
            const origPrint = window.print;
            window.print = () => { reportViolation('print_attempt', 'window.print blocked'); };
            cleanups.push(() => { window.print = origPrint; });

            // ══════════════════════════════════════
            // 11. MICRO-OPACITY FLICKERING OVERLAY
            // ══════════════════════════════════════
            // Invisible to human eye but disrupts screen recording
            const flickerDiv = document.createElement('div');
            flickerDiv.id = 'security-flicker-overlay';
            flickerDiv.style.cssText = `
                position: fixed; inset: 0; z-index: 99998;
                pointer-events: none;
                background: white;
                opacity: 0;
                mix-blend-mode: difference;
            `;
            document.body.appendChild(flickerDiv);

            let flickerFrame = 0;
            const flickerInterval = setInterval(() => {
                flickerFrame++;
                // Every 3rd frame, flash a barely perceptible opacity
                flickerDiv.style.opacity = (flickerFrame % 3 === 0) ? '0.005' : '0';
            }, 50);
            cleanups.push(() => {
                clearInterval(flickerInterval);
                flickerDiv.remove();
            });

            // ══════════════════════════════════════
            // 12. ENHANCED SCREENSHOT PROTECTION
            // ══════════════════════════════════════

            // A) Periodically clear clipboard to defeat PrintScreen
            const clipboardClearInterval = setInterval(() => {
                try {
                    navigator.clipboard.writeText('').catch(() => { });
                } catch (ex) { }
            }, 800);
            cleanups.push(() => clearInterval(clipboardClearInterval));

            // B) Hide video content when window loses focus (alt-tab screenshot defense)
            const handleBlur = () => {
                const vid = config.videoRef?.current;
                if (vid) {
                    vid.style.filter = 'brightness(0)';
                    vid.pause();
                }
            };
            const handleFocus = () => {
                const vid = config.videoRef?.current;
                if (vid) {
                    vid.style.filter = '';
                    vid.play().catch(() => { });
                }
            };
            window.addEventListener('blur', handleBlur, true);
            window.addEventListener('focus', handleFocus, true);
            cleanups.push(() => {
                window.removeEventListener('blur', handleBlur, true);
                window.removeEventListener('focus', handleFocus, true);
                // Restore filter on cleanup
                const vid = config.videoRef?.current;
                if (vid) vid.style.filter = '';
            });

        }, 1500); // 1.5s init delay

        // ══════════════════════════════════════
        // HEARTBEAT (starts immediately)
        // ══════════════════════════════════════

        heartbeatRef.current = setInterval(async () => {
            if (isKilledRef.current || !config.sessionId) return;
            try {
                const { url, init } = buildSecurityEventRequest('/secure-video/heartbeat', {
                    sessionId: config.sessionId,
                    sessionToken: sessionTokenRef.current
                });
                const resp = await fetch(url, init);

                if (!resp.ok) {
                    const data = await resp.json().catch(() => ({})) as { error?: string };
                    if (data.error === 'session_dead' || data.error === 'token_invalid') {
                        forceLogout('Session invalidated by server');
                    } else {
                        console.warn('[Security] Heartbeat rejected: HTTP', resp.status);
                    }
                }
            } catch (e) {
                // Network error - don't kill session, just log
                console.warn('[Security] Heartbeat failed:', e);
            }
        }, 5000);

        // Cleanup
        return () => {
            clearTimeout(initTimer);
            if (heartbeatRef.current) clearInterval(heartbeatRef.current);
            cleanups.forEach(fn => fn());
        };

    }, [config.sessionId, config.userId, config.videoId, reportViolation, forceLogout, blockScreen]);

    return {
        isBlocked,
        blockScreen,
        unblockScreen,
        forceLogout,
        reportViolation,
        restrictions
    };
}
