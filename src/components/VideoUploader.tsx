import { useState, useCallback, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Upload, X, CheckCircle, AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useUpload } from '@/contexts/UploadContext';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

interface VideoUploaderProps {
    courseId: string;
    lectureId?: string;
    materialId?: string;
    uploadedBy: string;
    onUploadComplete?: (videoId: string) => void;
    onCancel?: () => void;
    maxSizeMB?: number;
    title: string;
    description?: string;
}

interface UploadState {
    status: 'idle' | 'preparing' | 'uploading' | 'processing' | 'complete' | 'error';
    progress: number;
    videoId?: string;
    error?: string;
}

/**
 * Chunked video uploader with resumable upload support
 * Uploads directly to MinIO via presigned URLs
 */
export function VideoUploader({
    courseId,
    lectureId,
    materialId,
    uploadedBy,
    onUploadComplete,
    onCancel,
    maxSizeMB = 5000,
    title,
    description
}: VideoUploaderProps) {
    const { toast } = useToast();
    const { addUpload, updateUpload, startBackgroundPolling } = useUpload();
    const [file, setFile] = useState<File | null>(null);
    const [uploadState, setUploadState] = useState<UploadState>({
        status: 'idle',
        progress: 0
    });
    const abortControllerRef = useRef<AbortController | null>(null);
    const uploadIdRef = useRef<string | null>(null);
    const isUploadingRef = useRef(false);

    // Cleanup on unmount - DON'T abort uploads, let them continue in background
    useEffect(() => {
        return () => {
            // Uploads continue in background via UploadContext
            // No need to cleanup - global polling handles it
        };
    }, []);

    const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const selectedFile = e.target.files?.[0];
        if (!selectedFile) return;

        // Validate file type
        if (!selectedFile.type.startsWith('video/')) {
            toast({
                title: 'خطأ',
                description: 'يرجى اختيار ملف فيديو صالح',
                variant: 'destructive'
            });
            return;
        }

        // Validate file size
        const sizeMB = selectedFile.size / (1024 * 1024);
        if (sizeMB > maxSizeMB) {
            toast({
                title: 'خطأ',
                description: `حجم الملف كبير جداً. الحد الأقصى ${maxSizeMB}MB`,
                variant: 'destructive'
            });
            return;
        }

        setFile(selectedFile);
        setUploadState({ status: 'idle', progress: 0 });
    }, [maxSizeMB, toast]);

    const startUpload = useCallback(async () => {
        if (!file) return;

        abortControllerRef.current = new AbortController();

        try {
            // Step 1: Initialize upload
            setUploadState({ status: 'preparing', progress: 0 });

            const initResponse = await fetch(`${API_BASE}/videos/upload/init`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    course_id: courseId,
                    lecture_id: lectureId,
                    material_id: materialId,
                    title,
                    description,
                    file_name: file.name,
                    file_size: file.size,
                    uploaded_by: uploadedBy
                }),
                signal: abortControllerRef.current.signal
            });

            if (!initResponse.ok) {
                const error = await initResponse.json();
                throw new Error(error.error || 'Failed to initialize upload');
            }

            const { videoId, uploadUrl } = await initResponse.json();
            uploadIdRef.current = videoId;

            // Add to global upload context with onComplete callback
            addUpload(videoId, file.name, title, (completedVideoId) => {
                // This will be called when upload finishes successfully
                onUploadComplete?.(completedVideoId);
            });

            // Step 2: Upload file directly to MinIO
            setUploadState({ status: 'uploading', progress: 0, videoId });
            updateUpload(videoId, { stage: 'uploading', progress: 0 });

            await uploadToMinIO(uploadUrl, file, (progress) => {
                setUploadState(prev => ({ ...prev, progress }));
                updateUpload(videoId, { progress });
            }, abortControllerRef.current.signal);

            // Step 3: Complete upload and start processing (with retry)
            setUploadState(prev => ({ ...prev, status: 'processing', progress: 0 }));
            updateUpload(videoId, { stage: 'processing', progress: 0 });

            let completeSuccess = false;
            let lastError: Error | null = null;
            for (let attempt = 0; attempt < 5; attempt++) {
                try {
                    const completeResponse = await fetch(`${API_BASE}/videos/upload/complete`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ videoId }),
                        signal: abortControllerRef.current.signal
                    });

                    if (completeResponse.ok) {
                        completeSuccess = true;
                        break;
                    }
                    lastError = new Error(`Complete failed with status ${completeResponse.status}`);
                } catch (err) {
                    if (err instanceof Error && err.name === 'AbortError') throw err;
                    lastError = err instanceof Error ? err : new Error('Network error');
                }
                // Wait before retrying (2s, 4s, 8s, 16s)
                if (attempt < 4) {
                    await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt)));
                }
            }

            if (!completeSuccess) {
                throw lastError || new Error('Failed to complete upload after retries');
            }

            // Step 4: Start background polling (persists across page navigation)
            startBackgroundPolling(videoId);

        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                setUploadState({ status: 'idle', progress: 0 });
                if (uploadIdRef.current) {
                    updateUpload(uploadIdRef.current, { stage: 'error', error: 'تم إلغاء الرفع' });
                }
                return;
            }

            console.error('Upload error:', error);
            const errorMsg = error instanceof Error ? error.message : 'Upload failed';
            setUploadState({
                status: 'error',
                progress: 0,
                error: errorMsg
            });

            if (uploadIdRef.current) {
                updateUpload(uploadIdRef.current, { stage: 'error', error: errorMsg });
            }

            toast({
                title: 'خطأ في الرفع',
                description: error instanceof Error ? error.message : 'فشل رفع الفيديو',
                variant: 'destructive'
            });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [file, courseId, lectureId, materialId, title, description, uploadedBy, toast, addUpload, updateUpload]);

    /**
     * Upload file directly to MinIO via presigned URL
     * Uses XMLHttpRequest for progress tracking
     */
    async function uploadToMinIO(
        uploadUrl: string,
        file: File,
        onProgress: (progress: number) => void,
        signal: AbortSignal
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();

            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    const progress = Math.round((e.loaded / e.total) * 100);
                    onProgress(progress);
                }
            });

            xhr.addEventListener('load', () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve();
                } else {
                    reject(new Error(`Upload failed with status ${xhr.status}`));
                }
            });

            xhr.addEventListener('error', () => {
                reject(new Error('Network error during upload'));
            });

            xhr.addEventListener('abort', () => {
                reject(new Error('Upload cancelled'));
            });

            // Handle abort signal
            signal.addEventListener('abort', () => {
                xhr.abort();
            });

            xhr.open('PUT', uploadUrl);
            xhr.setRequestHeader('Content-Type', file.type);
            xhr.send(file);
        });
    }

    /**
     * Cancel upload
     */
    const cancelUpload = useCallback(() => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
        setFile(null);
        setUploadState({ status: 'idle', progress: 0 });
        onCancel?.();
    }, [onCancel]);

    const retryUpload = useCallback(() => {
        setUploadState({ status: 'idle', progress: 0 });
    }, []);

    const formatFileSize = (bytes: number): string => {
        if (bytes < 1024 * 1024) {
            return `${(bytes / 1024).toFixed(1)} KB`;
        }
        if (bytes < 1024 * 1024 * 1024) {
            return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        }
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    };

    return (
        <Card className="w-full">
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Upload className="h-5 w-5" />
                    رفع فيديو
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                {/* File Selection */}
                {uploadState.status === 'idle' && !file && (
                    <div className="border-2 border-dashed rounded-lg p-8 text-center hover:border-primary transition-colors">
                        <input
                            type="file"
                            accept="video/*"
                            onChange={handleFileSelect}
                            className="hidden"
                            id="video-upload"
                        />
                        <label htmlFor="video-upload" className="cursor-pointer">
                            <Upload className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                            <p className="text-lg font-medium">اسحب الفيديو هنا أو اضغط للاختيار</p>
                            <p className="text-sm text-muted-foreground mt-2">
                                الحد الأقصى: {maxSizeMB}MB • MP4, MOV, AVI, MKV
                            </p>
                        </label>
                    </div>
                )}

                {/* File Selected - Ready to Upload */}
                {uploadState.status === 'idle' && file && (
                    <div className="space-y-4">
                        <div className="flex items-center justify-between p-4 bg-muted rounded-lg">
                            <div>
                                <p className="font-medium">{file.name}</p>
                                <p className="text-sm text-muted-foreground">
                                    {formatFileSize(file.size)}
                                </p>
                            </div>
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => setFile(null)}
                            >
                                <X className="h-4 w-4" />
                            </Button>
                        </div>
                        <div className="flex gap-2">
                            <Button onClick={startUpload} className="flex-1">
                                <Upload className="h-4 w-4 ml-2" />
                                بدء الرفع
                            </Button>
                            <Button variant="outline" onClick={cancelUpload}>
                                إلغاء
                            </Button>
                        </div>
                    </div>
                )}

                {/* Uploading */}
                {(uploadState.status === 'preparing' || uploadState.status === 'uploading') && (
                    <div className="space-y-4">
                        <div className="flex items-center gap-2">
                            <Loader2 className="h-5 w-5 animate-spin text-primary" />
                            <span>
                                {uploadState.status === 'preparing'
                                    ? 'جاري التحضير...'
                                    : 'جاري الرفع...'}
                            </span>
                        </div>
                        <Progress value={uploadState.progress} className="h-2" />
                        <p className="text-sm text-muted-foreground text-center">
                            {uploadState.progress}%
                        </p>
                        <Button variant="outline" onClick={cancelUpload} className="w-full">
                            إلغاء الرفع
                        </Button>
                    </div>
                )}

                {/* Processing */}
                {uploadState.status === 'processing' && (
                    <div className="space-y-4">
                        <div className="flex items-center gap-2">
                            <Loader2 className="h-5 w-5 animate-spin text-orange-500" />
                            <span>جاري معالجة الفيديو...</span>
                        </div>
                        <Progress value={uploadState.progress} className="h-2" />
                        <p className="text-sm text-muted-foreground text-center">
                            تحويل الفيديو للبث: {uploadState.progress}%
                        </p>
                        <p className="text-xs text-muted-foreground text-center">
                            قد تستغرق هذه العملية عدة دقائق حسب حجم الفيديو
                        </p>
                    </div>
                )}

                {/* Complete */}
                {uploadState.status === 'complete' && (
                    <div className="text-center space-y-4">
                        <CheckCircle className="h-12 w-12 mx-auto text-green-500" />
                        <p className="text-lg font-medium text-green-600">
                            تم رفع الفيديو بنجاح!
                        </p>
                        <p className="text-sm text-muted-foreground">
                            الفيديو جاهز للمشاهدة الآن
                        </p>
                    </div>
                )}

                {/* Error */}
                {uploadState.status === 'error' && (
                    <div className="text-center space-y-4">
                        <AlertCircle className="h-12 w-12 mx-auto text-red-500" />
                        <p className="text-lg font-medium text-red-600">
                            فشل الرفع
                        </p>
                        <p className="text-sm text-muted-foreground">
                            {uploadState.error}
                        </p>
                        <div className="flex gap-2">
                            <Button onClick={retryUpload} className="flex-1">
                                <RefreshCw className="h-4 w-4 ml-2" />
                                إعادة المحاولة
                            </Button>
                            <Button variant="outline" onClick={cancelUpload}>
                                إلغاء
                            </Button>
                        </div>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

export default VideoUploader;
