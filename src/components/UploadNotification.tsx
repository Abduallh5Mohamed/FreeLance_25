import { useUpload } from '@/contexts/UploadContext';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Upload, CheckCircle, XCircle, X, Loader2, Minimize2, Maximize2 } from 'lucide-react';
import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export function UploadNotification() {
    const { uploads, removeUpload, cancelUpload, clearCompleted } = useUpload();
    const [isMinimized, setIsMinimized] = useState(false);

    const uploadArray = Array.from(uploads.values());
    const activeUploads = uploadArray.filter(u => u.stage === 'uploading' || u.stage === 'processing');
    const completedUploads = uploadArray.filter(u => u.stage === 'complete');
    const errorUploads = uploadArray.filter(u => u.stage === 'error');

    if (uploads.size === 0) return null;

    const getStageText = (stage: string) => {
        switch (stage) {
            case 'uploading': return 'جاري الرفع...';
            case 'processing': return 'جاري المعالجة...';
            case 'complete': return 'تم بنجاح';
            case 'error': return 'فشل';
            default: return stage;
        }
    };

    const getStageIcon = (stage: string) => {
        switch (stage) {
            case 'uploading': return <Upload className="h-4 w-4 animate-pulse" />;
            case 'processing': return <Loader2 className="h-4 w-4 animate-spin" />;
            case 'complete': return <CheckCircle className="h-4 w-4 text-green-500" />;
            case 'error': return <XCircle className="h-4 w-4 text-red-500" />;
            default: return null;
        }
    };

    return (
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0, y: 100 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 100 }}
                className="fixed bottom-4 left-4 z-50 w-96 max-w-[calc(100vw-2rem)]"
                dir="rtl"
            >
                <Card className="bg-background/95 backdrop-blur-lg shadow-2xl border-2 border-purple-500/20">
                    {/* Header */}
                    <div className="flex items-center justify-between p-3 border-b bg-gradient-to-r from-purple-50 to-pink-50 dark:from-gray-800 dark:to-gray-700">
                        <div className="flex items-center gap-2">
                            <div className="p-1.5 bg-purple-500 rounded-lg">
                                <Upload className="h-4 w-4 text-white" />
                            </div>
                            <div>
                                <h4 className="font-semibold text-sm">الرفوعات الجارية</h4>
                                <p className="text-xs text-muted-foreground">
                                    {activeUploads.length} نشط • {completedUploads.length} منتهي
                                    {errorUploads.length > 0 && ` • ${errorUploads.length} فشل`}
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center gap-1">
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                onClick={() => setIsMinimized(!isMinimized)}
                            >
                                {isMinimized ? <Maximize2 className="h-3 w-3" /> : <Minimize2 className="h-3 w-3" />}
                            </Button>
                            {completedUploads.length > 0 && (
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7"
                                    onClick={clearCompleted}
                                >
                                    <X className="h-3 w-3" />
                                </Button>
                            )}
                        </div>
                    </div>

                    {/* Upload List */}
                    {!isMinimized && (
                        <div className="max-h-96 overflow-y-auto">
                            {uploadArray.map((upload) => (
                                <div
                                    key={upload.lectureId}
                                    className="p-3 border-b last:border-b-0 hover:bg-muted/50 transition-colors"
                                >
                                    <div className="flex items-start justify-between gap-2 mb-2">
                                        <div className="flex items-start gap-2 flex-1 min-w-0">
                                            {getStageIcon(upload.stage)}
                                            <div className="flex-1 min-w-0">
                                                <p className="text-sm font-medium truncate">{upload.fileName}</p>
                                                {upload.courseTitle && (
                                                    <p className="text-xs text-muted-foreground truncate">{upload.courseTitle}</p>
                                                )}
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-1 shrink-0">
                                            {/* Cancel button for active uploads */}
                                            {(upload.stage === 'uploading' || upload.stage === 'processing') && (
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="h-6 w-6 text-red-500 hover:text-red-700 hover:bg-red-50"
                                                    onClick={() => cancelUpload(upload.lectureId)}
                                                    title="إلغاء الرفع"
                                                >
                                                    <X className="h-3 w-3" />
                                                </Button>
                                            )}
                                            {/* Remove button for completed/errored uploads */}
                                            {(upload.stage === 'complete' || upload.stage === 'error') && (
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="h-6 w-6"
                                                    onClick={() => removeUpload(upload.lectureId)}
                                                >
                                                    <X className="h-3 w-3" />
                                                </Button>
                                            )}
                                        </div>
                                    </div>

                                    {/* Progress Bar */}
                                    {(upload.stage === 'uploading' || upload.stage === 'processing') && (
                                        <div className="space-y-1">
                                            <Progress value={upload.progress} className="h-1.5" />
                                            <div className="flex justify-between text-xs text-muted-foreground">
                                                <span>{getStageText(upload.stage)}</span>
                                                <span>{Math.round(upload.progress)}%</span>
                                            </div>
                                        </div>
                                    )}

                                    {/* Status Messages */}
                                    {upload.stage === 'complete' && (
                                        <p className="text-xs text-green-600 dark:text-green-400">
                                            ✓ تم رفع ومعالجة الفيديو بنجاح
                                        </p>
                                    )}
                                    {upload.stage === 'error' && (
                                        <p className="text-xs text-red-600 dark:text-red-400">
                                            ✗ {upload.error || 'حدث خطأ أثناء الرفع'}
                                        </p>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </Card>
            </motion.div>
        </AnimatePresence>
    );
}
