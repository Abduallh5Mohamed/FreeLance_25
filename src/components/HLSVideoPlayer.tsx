import { useEffect, useRef, useState, useCallback, memo } from 'react';
import Hls from 'hls.js';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import {
    Play,
    Pause,
    Volume2,
    VolumeX,
    Maximize,
    Minimize,
    Settings,
    X,
    Loader2,
    AlertCircle,
    RefreshCw
} from 'lucide-react';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

interface HLSVideoPlayerProps {
    videoId: string;
    userId: string;
    title?: string;
    onClose?: () => void;
    autoPlay?: boolean;
    className?: string;
}

interface StreamData {
    videoId: string;
    title: string;
    description?: string;
    duration: number;
    qualities: string[];
    streamUrl: string;
    thumbnailUrl?: string;
    expiresIn: number;
}

/**
 * HLS Video Player with adaptive quality streaming
 * Secure video playback with signed URLs
 */
const HLSVideoPlayerComponent = ({
    videoId,
    userId,
    title,
    onClose,
    autoPlay = false,
    className = ''
}: HLSVideoPlayerProps) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const hlsRef = useRef<Hls | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);
    const progressRef = useRef<HTMLDivElement>(null);
    const timeDisplayRef = useRef<HTMLSpanElement>(null);

    const [streamData, setStreamData] = useState<StreamData | null>(null);
    const [loading, setLoading] = useState(false); // Start with false instead of true
    const [error, setError] = useState<string | null>(null);

    const [isPlaying, setIsPlaying] = useState(false);
    // Use refs instead of state for frequently updating values to prevent re-renders
    const currentTimeRef = useRef(0);
    const durationRef = useRef(0);
    const [volume, setVolume] = useState(1);
    const [isMuted, setIsMuted] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [showControls, setShowControls] = useState(true);
    const [currentQuality, setCurrentQuality] = useState<number>(-1); // -1 = auto
    const [availableLevels, setAvailableLevels] = useState<{ index: number; height: number }[]>([]);

    // Refresh stream URL for long videos
    const refreshStreamUrl = useCallback(async () => {
        try {
            const response = await fetch(`${API_BASE}/videos/stream/${videoId}/refresh`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId })
            });

            if (response.ok) {
                const data = await response.json();

                // Update HLS source
                if (hlsRef.current) {
                    hlsRef.current.loadSource(data.streamUrl);
                }

                // Schedule next refresh
                const refreshIn = (data.expiresIn - 60) * 1000;
                if (refreshIn > 0) {
                    refreshTimerRef.current = setTimeout(() => refreshStreamUrl(), refreshIn);
                }
            }
        } catch (err) {
            console.error('Error refreshing stream URL:', err);
        }
    }, [videoId, userId]);

    // Fetch stream URL
    const fetchStreamUrl = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);

            const streamUrl = `${API_BASE}/videos/stream/${videoId}?userId=${userId}`;
            console.log('🎥 Fetching stream from:', streamUrl);
            console.log('🔑 API_BASE:', API_BASE);
            console.log('🆔 Video ID:', videoId);
            console.log('👤 User ID:', userId);

            const response = await fetch(streamUrl);
            console.log('📡 Response status:', response.status);

            if (!response.ok) {
                const data = await response.json();
                console.error('❌ Error response:', data);
                throw new Error(data.error || 'Failed to load video');
            }

            const data: StreamData = await response.json();
            console.log('✅ Stream data received:', data);
            setStreamData(data);

            // Schedule URL refresh before expiry
            if (refreshTimerRef.current) {
                clearTimeout(refreshTimerRef.current);
            }
            // Refresh 1 minute before expiry
            const refreshIn = (data.expiresIn - 60) * 1000;
            if (refreshIn > 0) {
                refreshTimerRef.current = setTimeout(() => refreshStreamUrl(), refreshIn);
            }

            return data.streamUrl;
        } catch (err) {
            console.error('❌ Error fetching stream:', err);
            setError(err instanceof Error ? err.message : 'فشل تحميل الفيديو');
            return null;
        } finally {
            setLoading(false);
        }
    }, [videoId, userId, refreshStreamUrl]);

    // Initialize HLS player
    useEffect(() => {
        console.log('🎬 useEffect started - initializing player', { loading, videoRef: videoRef.current });

        // Don't initialize if still loading or no video element
        if (loading) {
            console.log('⏳ Still loading, skipping init');
            return;
        }

        const video = videoRef.current;
        if (!video) {
            console.log('❌ No video element found!');
            return;
        }

        console.log('✅ Video element found, starting initPlayer');

        async function initPlayer() {
            console.log('🚀 initPlayer function called');
            const streamUrl = await fetchStreamUrl();
            console.log('📡 fetchStreamUrl returned:', streamUrl);
            if (!streamUrl) return;

            if (Hls.isSupported()) {
                console.log('✅ HLS.js is supported, creating instance');
                // Use HLS.js for browsers that support it
                const hls = new Hls({
                    enableWorker: true,
                    lowLatencyMode: false,
                    backBufferLength: 90,
                    maxBufferLength: 30,
                    maxMaxBufferLength: 60,
                    startLevel: -1, // Auto quality selection
                    debug: true // Enable debug logging
                });

                console.log('📥 Loading source:', streamUrl);
                hls.loadSource(streamUrl);
                console.log('🔗 Attaching media to video element');
                hls.attachMedia(video);

                hls.on(Hls.Events.MEDIA_ATTACHED, () => {
                    console.log('✅ HLS: Media attached successfully');
                });

                hls.on(Hls.Events.MANIFEST_LOADING, () => {
                    console.log('📄 HLS: Loading manifest...');
                });

                hls.on(Hls.Events.MANIFEST_LOADED, (_, data) => {
                    console.log('📄 HLS: Manifest loaded', data);
                });

                hls.on(Hls.Events.FRAG_LOADING, (_, data) => {
                    console.log('📦 HLS: Loading fragment', data.frag.sn);
                });

                hls.on(Hls.Events.FRAG_LOADED, (_, data) => {
                    console.log('✅ HLS: Fragment loaded', data.frag.sn);
                });

                hls.on(Hls.Events.BUFFER_APPENDING, () => {
                    console.log('📝 HLS: Appending to buffer');
                });

                hls.on(Hls.Events.BUFFER_APPENDED, () => {
                    console.log('✅ HLS: Buffer appended');
                });

                hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
                    console.log('✅ HLS: Manifest parsed, levels:', data.levels.length);
                    const levels = data.levels.map((level, index) => ({
                        index,
                        height: level.height
                    }));
                    setAvailableLevels(levels);

                    if (autoPlay) {
                        // Mute first to allow autoplay, then unmute after play starts
                        video.muted = true;
                        console.log('▶️ Attempting autoplay...');
                        video.play()
                            .then(() => {
                                console.log('✅ Autoplay started successfully');
                                // Unmute after successful play
                                setTimeout(() => {
                                    video.muted = false;
                                    setIsMuted(false);
                                }, 100);
                                setIsPlaying(true);
                            })
                            .catch(err => {
                                console.error('❌ Autoplay failed:', err);
                                // Keep muted if autoplay fails
                                setIsMuted(true);
                            });
                    }
                });

                hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
                    console.log('🔄 HLS: Level switched to', data.level);
                    setCurrentQuality(data.level);
                });

                hls.on(Hls.Events.ERROR, (_, data) => {
                    console.error('❌ HLS Error:', data.type, data.details, data);
                    if (data.fatal) {
                        switch (data.type) {
                            case Hls.ErrorTypes.NETWORK_ERROR:
                                console.error('Network error - trying to recover');
                                hls.startLoad();
                                break;
                            case Hls.ErrorTypes.MEDIA_ERROR:
                                console.error('Media error - trying to recover');
                                hls.recoverMediaError();
                                break;
                            default:
                                console.error('Fatal error:', data);
                                setError('حدث خطأ في تشغيل الفيديو');
                                hls.destroy();
                                break;
                        }
                    }
                });

                hlsRef.current = hls;

            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                // Native HLS support (Safari)
                video.src = streamUrl;
                if (autoPlay) {
                    video.play().catch(console.error);
                }
            } else {
                setError('متصفحك لا يدعم تشغيل الفيديو');
            }
        }

        initPlayer();

        return () => {
            if (hlsRef.current) {
                hlsRef.current.destroy();
            }
            if (refreshTimerRef.current) {
                clearTimeout(refreshTimerRef.current);
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [videoId, userId, autoPlay]); // Remove loading from dependencies to prevent infinite loop

    // Video event handlers
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        // Local formatTime for use inside this effect
        const formatTimeLocal = (seconds: number) => {
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            const s = Math.floor(seconds % 60);
            if (h > 0) {
                return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
            }
            return `${m}:${s.toString().padStart(2, '0')}`;
        };

        // Update time display and progress bar directly without causing re-renders
        const handleTimeUpdate = () => {
            currentTimeRef.current = video.currentTime;
            // Update progress bar directly
            if (progressRef.current && durationRef.current > 0) {
                const percent = (video.currentTime / durationRef.current) * 100;
                progressRef.current.style.width = `${percent}%`;
            }
            // Update time display directly
            if (timeDisplayRef.current && durationRef.current > 0) {
                timeDisplayRef.current.textContent = `${formatTimeLocal(video.currentTime)} / ${formatTimeLocal(durationRef.current)}`;
            }
        };

        const handleDurationChange = () => {
            durationRef.current = video.duration;
        };
        const handlePlay = () => {
            setIsPlaying(true);
        };
        const handlePause = () => {
            setIsPlaying(false);
        };
        const handleVolumeChange = () => {
            setVolume(video.volume);
            setIsMuted(video.muted);
        };

        video.addEventListener('timeupdate', handleTimeUpdate);
        video.addEventListener('durationchange', handleDurationChange);
        video.addEventListener('play', handlePlay);
        video.addEventListener('pause', handlePause);
        video.addEventListener('volumechange', handleVolumeChange);

        return () => {
            video.removeEventListener('timeupdate', handleTimeUpdate);
            video.removeEventListener('durationchange', handleDurationChange);
            video.removeEventListener('play', handlePlay);
            video.removeEventListener('pause', handlePause);
            video.removeEventListener('volumechange', handleVolumeChange);
        };
    }, []);

    // Fullscreen handling
    useEffect(() => {
        const handleFullscreenChange = () => {
            setIsFullscreen(!!document.fullscreenElement);
        };

        document.addEventListener('fullscreenchange', handleFullscreenChange);
        return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
    }, []);

    // Auto-hide controls
    useEffect(() => {
        if (!isPlaying) return;

        let timeout: NodeJS.Timeout;
        const handleMouseMove = () => {
            setShowControls(true);
            clearTimeout(timeout);
            timeout = setTimeout(() => setShowControls(false), 3000);
        };

        const container = containerRef.current;
        container?.addEventListener('mousemove', handleMouseMove);

        return () => {
            container?.removeEventListener('mousemove', handleMouseMove);
            clearTimeout(timeout);
        };
    }, [isPlaying]);

    // Control functions
    const togglePlay = () => {
        if (videoRef.current) {
            if (isPlaying) {
                videoRef.current.pause();
                setIsPlaying(false);
            } else {
                videoRef.current.play()
                    .then(() => setIsPlaying(true))
                    .catch(err => {
                        console.error('Play failed:', err);
                        setIsPlaying(false);
                    });
            }
        }
    };

    const toggleMute = () => {
        if (videoRef.current) {
            videoRef.current.muted = !videoRef.current.muted;
        }
    };

    const handleVolumeChange = (value: number[]) => {
        if (videoRef.current) {
            videoRef.current.volume = value[0];
            if (value[0] === 0) {
                videoRef.current.muted = true;
            } else if (videoRef.current.muted) {
                videoRef.current.muted = false;
            }
        }
    };

    const handleSeek = (value: number[]) => {
        if (videoRef.current) {
            videoRef.current.currentTime = value[0];
        }
    };

    const toggleFullscreen = () => {
        if (!document.fullscreenElement) {
            containerRef.current?.requestFullscreen();
        } else {
            document.exitFullscreen();
        }
    };

    const changeQuality = (levelIndex: number) => {
        if (hlsRef.current) {
            hlsRef.current.currentLevel = levelIndex;
        }
    };

    const formatTime = (seconds: number): string => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);

        if (h > 0) {
            return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        }
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

    const getQualityLabel = (height: number): string => {
        if (height >= 1080) return '1080p';
        if (height >= 720) return '720p';
        if (height >= 480) return '480p';
        if (height >= 360) return '360p';
        return `${height}p`;
    };

    // Prevent right-click context menu
    const handleContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
    };

    if (loading) {
        return (
            <div className={`relative bg-black aspect-video flex items-center justify-center ${className}`}>
                <Loader2 className="h-12 w-12 animate-spin text-white" />
            </div>
        );
    }

    if (error) {
        return (
            <div className={`relative bg-black aspect-video flex flex-col items-center justify-center ${className}`}>
                <AlertCircle className="h-12 w-12 text-red-500 mb-4" />
                <p className="text-white mb-4">{error}</p>
                <Button onClick={() => fetchStreamUrl()} variant="outline">
                    <RefreshCw className="h-4 w-4 ml-2" />
                    إعادة المحاولة
                </Button>
            </div>
        );
    }

    return (
        <div
            ref={containerRef}
            className={`relative bg-black w-full h-full flex items-center justify-center ${className}`}
            onContextMenu={handleContextMenu}
        >
            {/* Video Element */}
            <video
                ref={videoRef}
                className="h-full w-auto"
                style={{ maxWidth: '100vw' }}
                playsInline
                preload="auto"
                onClick={togglePlay}
                controls
            />

            {/* Close Button */}
            {onClose && (
                <Button
                    variant="ghost"
                    size="icon"
                    className="absolute top-4 right-4 bg-black/50 hover:bg-black/70 text-white z-10"
                    onClick={onClose}
                >
                    <X className="h-5 w-5" />
                </Button>
            )}

            {/* Video Title */}
            {(title || streamData?.title) && showControls && (
                <div className="absolute top-4 left-4 right-16 z-10 transition-opacity duration-300">
                    <p className="text-white font-medium truncate text-lg drop-shadow-lg">
                        {title || streamData?.title}
                    </p>
                </div>
            )}

            {/* Play/Pause Overlay */}
            {!isPlaying && (
                <div
                    className="absolute inset-0 flex items-center justify-center cursor-pointer"
                    onClick={togglePlay}
                >
                    <div className="p-4 bg-white/20 rounded-full backdrop-blur-sm">
                        <Play className="h-12 w-12 text-white" fill="white" />
                    </div>
                </div>
            )}

            {/* Controls */}
            <div
                className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4 transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0'
                    }`}
            >
                {/* Progress Bar - Custom implementation to avoid re-renders */}
                <div className="mb-3">
                    <div
                        className="relative h-2 bg-white/30 rounded-full cursor-pointer group"
                        onClick={(e) => {
                            const rect = e.currentTarget.getBoundingClientRect();
                            const percent = (e.clientX - rect.left) / rect.width;
                            const time = percent * durationRef.current;
                            if (videoRef.current) {
                                videoRef.current.currentTime = time;
                            }
                        }}
                    >
                        <div
                            ref={progressRef}
                            className="absolute top-0 left-0 h-full bg-primary rounded-full transition-none"
                            style={{ width: '0%' }}
                        />
                        <div
                            className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full shadow-lg opacity-0 group-hover:opacity-100 transition-opacity"
                            style={{ left: `calc(${progressRef.current?.style.width || '0%'} - 8px)` }}
                        />
                    </div>
                </div>

                {/* Control Buttons */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        {/* Play/Pause */}
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={togglePlay}
                            className="text-white hover:bg-white/20"
                        >
                            {isPlaying ? (
                                <Pause className="h-5 w-5" />
                            ) : (
                                <Play className="h-5 w-5" />
                            )}
                        </Button>

                        {/* Volume */}
                        <div className="flex items-center gap-2">
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={toggleMute}
                                className="text-white hover:bg-white/20"
                            >
                                {isMuted || volume === 0 ? (
                                    <VolumeX className="h-5 w-5" />
                                ) : (
                                    <Volume2 className="h-5 w-5" />
                                )}
                            </Button>
                            <Slider
                                value={[isMuted ? 0 : volume]}
                                max={1}
                                step={0.1}
                                onValueChange={handleVolumeChange}
                                className="w-20"
                            />
                        </div>

                        {/* Time */}
                        <span ref={timeDisplayRef} className="text-white text-sm">
                            0:00 / 0:00
                        </span>
                    </div>

                    <div className="flex items-center gap-2">
                        {/* Quality Selector */}
                        {availableLevels.length > 0 && (
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="text-white hover:bg-white/20"
                                    >
                                        <Settings className="h-5 w-5" />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuItem
                                        onClick={() => changeQuality(-1)}
                                        className={currentQuality === -1 ? 'bg-accent' : ''}
                                    >
                                        تلقائي
                                    </DropdownMenuItem>
                                    {availableLevels.map((level) => (
                                        <DropdownMenuItem
                                            key={level.index}
                                            onClick={() => changeQuality(level.index)}
                                            className={currentQuality === level.index ? 'bg-accent' : ''}
                                        >
                                            {getQualityLabel(level.height)}
                                        </DropdownMenuItem>
                                    ))}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        )}

                        {/* Fullscreen */}
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={toggleFullscreen}
                            className="text-white hover:bg-white/20"
                        >
                            {isFullscreen ? (
                                <Minimize className="h-5 w-5" />
                            ) : (
                                <Maximize className="h-5 w-5" />
                            )}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
};

// Wrap with memo to prevent unnecessary re-renders
export const HLSVideoPlayer = memo(HLSVideoPlayerComponent);

export default HLSVideoPlayer;
