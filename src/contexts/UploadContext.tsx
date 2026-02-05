import { createContext, useContext, useState, ReactNode, useEffect, useRef } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

interface UploadProgress {
    lectureId: string;
    fileName: string;
    progress: number;
    stage: 'uploading' | 'processing' | 'complete' | 'error';
    error?: string;
    courseTitle?: string;
    onComplete?: (videoId: string) => void;
}

interface UploadContextType {
    uploads: Map<string, UploadProgress>;
    addUpload: (id: string, fileName: string, courseTitle?: string, onComplete?: (videoId: string) => void) => void;
    updateUpload: (id: string, progress: Partial<UploadProgress>) => void;
    removeUpload: (id: string) => void;
    cancelUpload: (id: string) => Promise<void>;
    clearCompleted: () => void;
    startBackgroundPolling: (videoId: string) => void;
}

const UploadContext = createContext<UploadContextType | undefined>(undefined);

export function UploadProvider({ children }: { children: ReactNode }) {
    const [uploads, setUploads] = useState<Map<string, UploadProgress>>(new Map());
    const pollingIntervalsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

    // Cleanup all polling on unmount
    useEffect(() => {
        const intervals = pollingIntervalsRef.current;
        return () => {
            intervals.forEach(interval => clearInterval(interval));
        };
    }, []);

    const addUpload = (id: string, fileName: string, courseTitle?: string, onComplete?: (videoId: string) => void) => {
        setUploads(prev => {
            const newMap = new Map(prev);
            newMap.set(id, {
                lectureId: id,
                fileName,
                progress: 0,
                stage: 'uploading',
                courseTitle,
                onComplete
            });
            return newMap;
        });
    };

    const updateUpload = (id: string, progress: Partial<UploadProgress>) => {
        setUploads(prev => {
            const newMap = new Map(prev);
            const current = newMap.get(id);
            if (current) {
                newMap.set(id, { ...current, ...progress });
            }
            return newMap;
        });
    };

    const cancelUpload = async (id: string) => {
        try {
            // Call backend to delete files and database record
            await fetch(`${API_BASE}/videos/upload/cancel/${id}`, {
                method: 'DELETE'
            });

            // Stop polling
            const interval = pollingIntervalsRef.current.get(id);
            if (interval) {
                clearInterval(interval);
                pollingIntervalsRef.current.delete(id);
            }

            // Remove from state
            setUploads(prev => {
                const newMap = new Map(prev);
                newMap.delete(id);
                return newMap;
            });
        } catch (error) {
            console.error('Failed to cancel upload:', error);
            // Still remove from UI even if backend fails
            removeUpload(id);
        }
    };

    const removeUpload = (id: string) => {
        // Stop polling for this upload
        const interval = pollingIntervalsRef.current.get(id);
        if (interval) {
            clearInterval(interval);
            pollingIntervalsRef.current.delete(id);
        }

        setUploads(prev => {
            const newMap = new Map(prev);
            newMap.delete(id);
            return newMap;
        });
    };

    const clearCompleted = () => {
        setUploads(prev => {
            const newMap = new Map(prev);
            Array.from(newMap.entries()).forEach(([id, upload]) => {
                if (upload.stage === 'complete' || upload.stage === 'error') {
                    // Stop polling
                    const interval = pollingIntervalsRef.current.get(id);
                    if (interval) {
                        clearInterval(interval);
                        pollingIntervalsRef.current.delete(id);
                    }
                    newMap.delete(id);
                }
            });
            return newMap;
        });
    };

    const startBackgroundPolling = (videoId: string) => {
        // Don't start if already polling
        if (pollingIntervalsRef.current.has(videoId)) {
            return;
        }

        const interval = setInterval(async () => {
            try {
                const response = await fetch(`${API_BASE}/videos/upload/status/${videoId}`);
                const data = await response.json();

                if (data.status === 'ready') {
                    // Upload complete
                    updateUpload(videoId, { stage: 'complete', progress: 100 });

                    // Call onComplete callback if exists
                    setUploads(prev => {
                        const upload = prev.get(videoId);
                        if (upload?.onComplete) {
                            // Use setTimeout to avoid render phase update
                            setTimeout(() => upload.onComplete(videoId), 0);
                        }
                        return prev;
                    });

                    const intervalToStop = pollingIntervalsRef.current.get(videoId);
                    if (intervalToStop) {
                        clearInterval(intervalToStop);
                        pollingIntervalsRef.current.delete(videoId);
                    }
                } else if (data.status === 'failed') {
                    // Upload failed
                    updateUpload(videoId, {
                        stage: 'error',
                        error: data.processing_error || 'فشلت المعالجة'
                    });
                    const intervalToStop = pollingIntervalsRef.current.get(videoId);
                    if (intervalToStop) {
                        clearInterval(intervalToStop);
                        pollingIntervalsRef.current.delete(videoId);
                    }
                } else if (data.status === 'processing') {
                    // Still processing
                    updateUpload(videoId, {
                        stage: 'processing',
                        progress: data.processing_progress || 0
                    });
                }
            } catch (error) {
                console.error('Background polling error:', error);
            }
        }, 3000); // Poll every 3 seconds

        pollingIntervalsRef.current.set(videoId, interval);
    };

    return (
        <UploadContext.Provider value={{
            uploads,
            addUpload,
            updateUpload,
            removeUpload,
            cancelUpload,
            clearCompleted,
            startBackgroundPolling
        }}>
            {children}
        </UploadContext.Provider>
    );
}

// Export hook separately to avoid Fast Refresh warnings
export const useUpload = () => {
    const context = useContext(UploadContext);
    if (!context) {
        throw new Error('useUpload must be used within UploadProvider');
    }
    return context;
};
