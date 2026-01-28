import { X } from "lucide-react";
import { Button } from "./ui/button";
import { useEffect, useMemo, memo } from "react";
import { HLSVideoPlayer } from "./HLSVideoPlayer";

interface VideoPlayerProps {
    url: string;
    title?: string;
    userId?: string;
    onClose: () => void;
}

/**
 * Component to display videos from either Google Drive or MinIO (self-hosted)
 * - Google Drive: Converts sharing links to embeddable iframe URLs
 * - MinIO: video://[videoId] format - uses HLS player for adaptive streaming
 */
const VideoPlayerComponent = ({ url, title, userId, onClose }: VideoPlayerProps) => {
    // Handle ESC key to close
    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleEscape);
        return () => window.removeEventListener('keydown', handleEscape);
    }, [onClose]);

    // Check if this is a self-hosted MinIO video - use useMemo to prevent recalculation
    const isMinIOVideo = useMemo(() => url.startsWith('video://'), [url]);
    const videoId = useMemo(() => isMinIOVideo ? url.replace('video://', '') : null, [url, isMinIOVideo]);

    // Convert Google Drive sharing URL to embed URL - use useMemo
    const embedUrl = useMemo(() => {
        const getEmbedUrl = (driveUrl: string): string => {
            // Extract file ID from various Google Drive URL formats
            const patterns = [
                /\/file\/d\/([a-zA-Z0-9_-]+)/,
                /[?&]id=([a-zA-Z0-9_-]+)/,
                /\/d\/([a-zA-Z0-9_-]+)/
            ];

            for (const pattern of patterns) {
                const match = driveUrl.match(pattern);
                if (match && match[1]) {
                    // Try using the preview URL which works better in most cases
                    return `https://drive.google.com/file/d/${match[1]}/preview`;
                }
            }

            // If already an embed URL or unknown format, return as-is
            return driveUrl;
        };

        return getEmbedUrl(url);
    }, [url]);

    return (
        <div className="fixed inset-0 z-50 bg-black flex items-center justify-center">
            <div className="relative w-full h-full flex flex-col">
                {/* Header - Minimal & Compact */}
                <div className="flex items-center justify-between px-4 py-2 bg-gradient-to-r from-purple-900/50 to-pink-900/50 backdrop-blur-sm border-b border-purple-500/20 absolute top-0 left-0 right-0 z-10">
                    <div className="flex items-center gap-2">
                        <div className="p-1.5 bg-purple-500 rounded-md">
                            <svg className="h-4 w-4 text-white" fill="currentColor" viewBox="0 0 20 20">
                                <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
                            </svg>
                        </div>
                        <h3 className="text-sm font-bold truncate text-white drop-shadow-md">
                            {title || 'عرض الفيديو'}
                        </h3>
                    </div>
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={onClose}
                        className="shrink-0 hover:bg-red-500/20 hover:text-red-400 text-white transition-colors rounded-full h-8 w-8 p-0"
                    >
                        <X className="h-5 w-5" />
                    </Button>
                </div>

                {/* Video Player - Full Screen */}
                <div className="flex-1 relative flex items-center justify-center">
                    {isMinIOVideo && videoId && userId ? (
                        <HLSVideoPlayer
                            videoId={videoId}
                            userId={userId}
                            autoPlay={true}
                            className="w-full h-full"
                        />
                    ) : (
                        <>
                            <iframe
                                src={embedUrl}
                                className="w-full h-full"
                                allow="autoplay; encrypted-media; fullscreen"
                                allowFullScreen
                                title={title || 'Video Player'}
                                onError={() => {
                                    console.warn('iframe failed to load, trying alternative method');
                                }}
                            />
                            {/* Fallback message */}
                            <noscript>
                                <div className="absolute inset-0 flex items-center justify-center bg-black/80 text-white text-center p-4">
                                    <div>
                                        <p className="text-lg font-semibold mb-4">فيديو من Google Drive</p>
                                        <p className="text-sm mb-4">إذا لم يتم تحميل الفيديو، جرب:</p>
                                        <a
                                            href={embedUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-block px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-white"
                                        >
                                            فتح الفيديو مباشرة
                                        </a>
                                    </div>
                                </div>
                            </noscript>
                        </>
                    )}
                </div>

                {/* Footer - Minimal */}
                <div className="px-4 py-1.5 bg-gradient-to-r from-purple-900/50 to-pink-900/50 backdrop-blur-sm border-t border-purple-500/20 text-center absolute bottom-0 left-0 right-0 z-10">
                    <p className="text-xs text-gray-300">
                        💡 ESC للخروج{isMinIOVideo && ' • بث مباشر'}
                    </p>
                </div>
            </div>
        </div>
    );
};

// Wrap with memo to prevent unnecessary re-renders
export const VideoPlayer = memo(VideoPlayerComponent);
