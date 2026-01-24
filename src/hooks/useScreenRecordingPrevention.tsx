import { useEffect, useCallback, useRef, useState } from 'react';

interface ProtectionOptions {
  showWatermark?: boolean;
  studentName?: string;
  blockDevTools?: boolean;
}

interface StudentData {
  name: string;
  group: string;
  grade: string;
}

export const useScreenRecordingPrevention = (options: ProtectionOptions = {}) => {
  const { showWatermark = true, studentName, blockDevTools = true } = options;
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const [isBlurred, setIsBlurred] = useState(false);

  // Get student info from localStorage including group and grade
  const getStudentInfo = useCallback((): StudentData => {
    try {
      const studentStr = localStorage.getItem('currentStudent');
      const userStr = localStorage.getItem('currentUser');
      if (studentStr) {
        const student = JSON.parse(studentStr);
        return {
          name: student.name || student.email || 'طالب',
          group: student.group_name || student.group?.name || '',
          grade: student.grade_name || student.grade?.name || ''
        };
      }
      if (userStr) {
        const user = JSON.parse(userStr);
        return {
          name: user.name || user.email || 'طالب',
          group: user.group_name || '',
          grade: user.grade_name || ''
        };
      }
    } catch {
      return { name: 'طالب', group: '', grade: '' };
    }
    return { name: studentName || 'طالب', group: '', grade: '' };
  }, [studentName]);

  // Debounced blocked message to prevent hanging
  const showBlockedMessageDebounced = useCallback(() => {
    // Check if already showing
    if (document.getElementById('screen-capture-blocked')) return;
    
    requestAnimationFrame(() => {
      const overlay = document.createElement('div');
      overlay.id = 'screen-capture-blocked';
      overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
        z-index: 999999;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-direction: column;
        color: white;
        font-family: 'Segoe UI', Tahoma, sans-serif;
        opacity: 0;
        transition: opacity 0.3s ease;
      `;
      overlay.innerHTML = `
        <div style="text-align: center; padding: 40px; max-width: 500px;">
          <div style="font-size: 80px; margin-bottom: 20px;">⛔</div>
          <h2 style="margin-bottom: 15px; font-size: 28px;">تم رصد محاولة تسجيل!</h2>
          <p style="opacity: 0.9; font-size: 18px; line-height: 1.6;">
            لحماية المحتوى التعليمي، لا يُسمح بتصوير الشاشة أو تسجيلها.
          </p>
          <p style="opacity: 0.6; font-size: 14px; margin-top: 20px;">
            ⏱️ سيتم إغلاق هذه الرسالة تلقائياً...
          </p>
          <div style="margin-top: 30px; padding: 15px; background: rgba(255,255,255,0.1); border-radius: 10px;">
            <p style="font-size: 12px; opacity: 0.7;">
              تم تسجيل هذه المحاولة في النظام
            </p>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      
      // Fade in
      requestAnimationFrame(() => {
        overlay.style.opacity = '1';
      });
      
      // Auto remove after 3 seconds
      setTimeout(() => {
        if (document.body.contains(overlay)) {
          overlay.style.opacity = '0';
          setTimeout(() => {
            if (document.body.contains(overlay)) {
              document.body.removeChild(overlay);
            }
          }, 300);
        }
      }, 3000);
    });
  }, []);

  // Clear clipboard safely
  const clearClipboard = useCallback(() => {
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText('محتوى محمي').catch(() => {});
      }
    } catch {
      // Silently fail
    }
  }, []);

  // Blur content when screen capture is detected
  const blurContent = useCallback(() => {
    setIsBlurred(true);
    document.body.classList.add('capture-detected');
    showBlockedMessageDebounced();
    clearClipboard();
    
    // Unblur after a short delay
    setTimeout(() => {
      setIsBlurred(false);
      document.body.classList.remove('capture-detected');
    }, 3500);
  }, [showBlockedMessageDebounced, clearClipboard]);

  useEffect(() => {
    const studentData = getStudentInfo();
    const studentInfo = studentData.name;
    const groupInfo = studentData.group;
    const gradeInfo = studentData.grade;

    // ===== Enhanced CSS Protection =====
    const style = document.createElement('style');
    style.id = 'screen-capture-prevention-styles';
    style.textContent = `
      /* Disable all selection */
      .screen-protected,
      .screen-protected * {
        -webkit-touch-callout: none !important;
        -webkit-user-select: none !important;
        -khtml-user-select: none !important;
        -moz-user-select: none !important;
        -ms-user-select: none !important;
        user-select: none !important;
      }
      
      /* Blur when capture detected */
      .capture-detected {
        filter: blur(25px) !important;
        transition: filter 0.1s ease !important;
      }
      
      /* Hide content completely when printing */
      @media print {
        html, body, * {
          display: none !important;
          visibility: hidden !important;
          opacity: 0 !important;
        }
      }

      /* Watermark pattern */
      #dynamic-watermark {
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        width: 100% !important;
        height: 100% !important;
        pointer-events: none !important;
        z-index: 99999 !important;
        overflow: hidden !important;
      }

      .watermark-text {
        position: absolute;
        font-size: 12px;
        font-weight: 600;
        color: rgba(0, 0, 0, 0.03);
        white-space: nowrap;
        transform: rotate(-35deg);
        font-family: 'Segoe UI', Tahoma, sans-serif;
        direction: rtl;
        text-shadow: 0 0 1px rgba(0,0,0,0.01);
      }

      /* Disable drag */
      .screen-protected img,
      .screen-protected video {
        -webkit-user-drag: none !important;
        user-drag: none !important;
      }

      /* DevTools detection styles */
      .devtools-open {
        filter: blur(20px) !important;
      }
      
      /* Block pointer events on images when needed */
      .screen-protected img.protected-image {
        pointer-events: none !important;
      }
    `;
    
    if (!document.getElementById('screen-capture-prevention-styles')) {
      document.head.appendChild(style);
    }
    document.body.classList.add('screen-protected');

    // ===== Create Dynamic Watermark with Student Info =====
    const existingWatermark = document.getElementById('dynamic-watermark');
    if (existingWatermark) {
      existingWatermark.remove();
    }
    
    if (showWatermark) {
      const watermarkContainer = document.createElement('div');
      watermarkContainer.id = 'dynamic-watermark';
      
      // Create grid of watermarks with optimized count
      let watermarkHTML = '';
      const rows = 8;
      const cols = 4;
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const top = 5 + (row * (100 / rows));
          const left = -5 + (col * (100 / cols));
          // Show student name, group, and grade
          const watermarkText = [studentInfo, gradeInfo, groupInfo].filter(Boolean).join(' | ') || studentInfo;
          watermarkHTML += `
            <div class="watermark-text" style="top: ${top}%; left: ${left}%;">
              ${watermarkText} | منصة القائد
            </div>
          `;
        }
      }
      watermarkContainer.innerHTML = watermarkHTML;
      document.body.appendChild(watermarkContainer);
    }

    // ===== Prevent right-click =====
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      return false;
    };

    // ===== Optimized Keyboard Protection =====
    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key?.toLowerCase();
      const code = e.code?.toLowerCase();
      
      // Print Screen - blur and clear clipboard
      if (key === 'printscreen' || code === 'printscreen') {
        e.preventDefault();
        blurContent();
        return false;
      }

      // Windows + Shift + S (Snipping Tool)
      if ((e.metaKey || e.key === 'Meta') && e.shiftKey && key === 's') {
        e.preventDefault();
        blurContent();
        return false;
      }

      // Ctrl + Shift + S (Various screenshot tools)
      if (e.ctrlKey && e.shiftKey && key === 's') {
        e.preventDefault();
        blurContent();
        return false;
      }

      // Ctrl + P (Print)
      if (e.ctrlKey && key === 'p') {
        e.preventDefault();
        showBlockedMessageDebounced();
        return false;
      }

      // Ctrl + S (Save)
      if (e.ctrlKey && !e.shiftKey && key === 's') {
        e.preventDefault();
        return false;
      }

      // DevTools prevention
      if (blockDevTools) {
        // F12
        if (key === 'f12' || code === 'f12') {
          e.preventDefault();
          return false;
        }

        // Ctrl + Shift + I, J, C
        if (e.ctrlKey && e.shiftKey && (key === 'i' || key === 'j' || key === 'c')) {
          e.preventDefault();
          return false;
        }

        // Ctrl + U (View Source)
        if (e.ctrlKey && key === 'u') {
          e.preventDefault();
          return false;
        }
      }

      // Ctrl + A (Select All)
      if (e.ctrlKey && key === 'a') {
        e.preventDefault();
        return false;
      }

      // Ctrl + C (Copy)
      if (e.ctrlKey && key === 'c') {
        e.preventDefault();
        return false;
      }
    };

    // ===== Screen Capture API Detection (for external tools) =====
    let mediaRecorderDetectionActive = true;
    
    const detectScreenCapture = async () => {
      try {
        // Try to detect if getDisplayMedia is being used
        const originalGetDisplayMedia = navigator.mediaDevices?.getDisplayMedia;
        if (originalGetDisplayMedia) {
          navigator.mediaDevices.getDisplayMedia = async function() {
            // Show warning when screen sharing is attempted
            blurContent();
            throw new Error('Screen capture is not allowed');
          };
        }
      } catch {
        // Silently fail
      }
    };
    
    detectScreenCapture();

    // ===== DevTools Detection (Optimized - less frequent checks) =====
    const detectDevTools = () => {
      if (!blockDevTools) return;
      
      const threshold = 160;
      const widthDiff = window.outerWidth - window.innerWidth > threshold;
      const heightDiff = window.outerHeight - window.innerHeight > threshold;
      
      if (widthDiff || heightDiff) {
        document.body.classList.add('devtools-open');
      } else {
        document.body.classList.remove('devtools-open');
      }
    };

    // ===== Visibility Change Detection =====
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        clearClipboard();
      }
    };

    // ===== Focus/Blur Detection for External Tools =====
    const handleWindowBlur = () => {
      // When window loses focus, it might be due to screenshot tool
      // Add a subtle watermark boost
      const watermark = document.getElementById('dynamic-watermark');
      if (watermark) {
        watermark.style.opacity = '1.5';
      }
    };
    
    const handleWindowFocus = () => {
      const watermark = document.getElementById('dynamic-watermark');
      if (watermark) {
        watermark.style.opacity = '1';
      }
    };

    // ===== Prevent Drag & Drop =====
    const handleDragStart = (e: DragEvent) => {
      e.preventDefault();
      return false;
    };

    // ===== Setup Event Listeners =====
    document.addEventListener('contextmenu', handleContextMenu, { passive: false });
    document.addEventListener('keydown', handleKeyDown, { passive: false });
    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('dragstart', handleDragStart, { passive: false });
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('focus', handleWindowFocus);
    
    // Check DevTools less frequently (every 2 seconds instead of 1)
    intervalRef.current = setInterval(detectDevTools, 2000);
    detectDevTools();

    // ===== Cleanup Function =====
    cleanupRef.current = () => {
      const watermark = document.getElementById('dynamic-watermark');
      if (watermark && document.body.contains(watermark)) {
        watermark.remove();
      }
      
      document.body.classList.remove('screen-protected', 'devtools-open', 'capture-detected');
      
      const styleEl = document.getElementById('screen-capture-prevention-styles');
      if (styleEl && document.head.contains(styleEl)) {
        styleEl.remove();
      }
      
      document.removeEventListener('contextmenu', handleContextMenu);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('dragstart', handleDragStart);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('focus', handleWindowFocus);
      
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      
      const blockedOverlay = document.getElementById('screen-capture-blocked');
      if (blockedOverlay && document.body.contains(blockedOverlay)) {
        blockedOverlay.remove();
      }
      
      mediaRecorderDetectionActive = false;
    };

    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
      }
    };
  }, [showWatermark, getStudentInfo, showBlockedMessageDebounced, blockDevTools, blurContent, clearClipboard]);

  return { isBlurred };
};

