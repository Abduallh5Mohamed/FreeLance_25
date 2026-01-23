import { useEffect, useCallback, useRef } from 'react';

interface ProtectionOptions {
  showWatermark?: boolean;
  studentName?: string;
  blockDevTools?: boolean;
}

export const useScreenRecordingPrevention = (options: ProtectionOptions = {}) => {
  const { showWatermark = true, studentName, blockDevTools = true } = options;
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // Get student info from localStorage
  const getStudentInfo = useCallback(() => {
    try {
      const studentStr = localStorage.getItem('currentStudent');
      const userStr = localStorage.getItem('currentUser');
      if (studentStr) {
        const student = JSON.parse(studentStr);
        return student.name || student.email || 'طالب';
      }
      if (userStr) {
        const user = JSON.parse(userStr);
        return user.name || user.email || 'طالب';
      }
    } catch {
      return 'طالب';
    }
    return studentName || 'طالب';
  }, [studentName]);

  const showBlockedMessage = useCallback(() => {
    // Check if already showing
    if (document.getElementById('screen-capture-blocked')) return;
    
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
      animation: fadeIn 0.3s ease;
    `;
    overlay.innerHTML = `
      <style>
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.1); } }
        @keyframes shake { 0%, 100% { transform: translateX(0); } 25% { transform: translateX(-5px); } 75% { transform: translateX(5px); } }
      </style>
      <div style="text-align: center; padding: 40px; max-width: 500px;">
        <div style="font-size: 80px; margin-bottom: 20px; animation: pulse 1s infinite;">⛔</div>
        <h2 style="margin-bottom: 15px; font-size: 28px; animation: shake 0.5s;">تم رصد محاولة تسجيل!</h2>
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
    
    setTimeout(() => {
      if (document.body.contains(overlay)) {
        overlay.style.animation = 'fadeOut 0.3s ease forwards';
        setTimeout(() => {
          if (document.body.contains(overlay)) {
            document.body.removeChild(overlay);
          }
        }, 300);
      }
    }, 4000);
  }, []);

  useEffect(() => {
    const studentInfo = getStudentInfo();
    const timestamp = new Date().toLocaleString('ar-EG');

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
      
      /* Hide content completely when printing */
      @media print {
        html, body {
          display: none !important;
          visibility: hidden !important;
        }
      }

      /* Add noise effect to make screenshots less useful */
      .screen-protected::before {
        content: '';
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 99998;
        background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='1' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%' height='100%' filter='url(%23noise)' opacity='0.03'/%3E%3C/svg%3E");
        opacity: 0.02;
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
        font-size: 14px;
        font-weight: 500;
        color: rgba(0, 0, 0, 0.04);
        white-space: nowrap;
        transform: rotate(-30deg);
        font-family: 'Segoe UI', Tahoma, sans-serif;
        direction: rtl;
      }

      /* Disable drag */
      .screen-protected img,
      .screen-protected video {
        -webkit-user-drag: none !important;
        user-drag: none !important;
        pointer-events: none !important;
      }

      /* DevTools detection styles */
      .devtools-open {
        filter: blur(20px) !important;
      }
    `;
    document.head.appendChild(style);
    document.body.classList.add('screen-protected');

    // ===== Create Dynamic Watermark with Student Info =====
    if (showWatermark) {
      const watermarkContainer = document.createElement('div');
      watermarkContainer.id = 'dynamic-watermark';
      
      // Create grid of watermarks
      let watermarkHTML = '';
      for (let row = 0; row < 10; row++) {
        for (let col = 0; col < 5; col++) {
          const top = 10 + (row * 10);
          const left = -10 + (col * 25);
          watermarkHTML += `
            <div class="watermark-text" style="top: ${top}%; left: ${left}%;">
              ${studentInfo} | ${timestamp} | منصة القائد
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
      e.stopPropagation();
      return false;
    };

    // ===== Keyboard Protection =====
    const handleKeyDown = (e: KeyboardEvent) => {
      // Print Screen variations
      if (e.key === 'PrintScreen' || e.code === 'PrintScreen') {
        e.preventDefault();
        navigator.clipboard?.writeText?.('محتوى محمي').catch(() => {});
        showBlockedMessage();
        return false;
      }

      // Windows + Shift + S (Snipping Tool)
      if ((e.metaKey || e.key === 'Meta') && e.shiftKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        showBlockedMessage();
        return false;
      }

      // Ctrl + Shift + S
      if (e.ctrlKey && e.shiftKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        showBlockedMessage();
        return false;
      }

      // Ctrl + P (Print)
      if (e.ctrlKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        showBlockedMessage();
        return false;
      }

      // Ctrl + S (Save)
      if (e.ctrlKey && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        return false;
      }

      // DevTools prevention
      if (blockDevTools) {
        // F12
        if (e.key === 'F12' || e.code === 'F12') {
          e.preventDefault();
          return false;
        }

        // Ctrl + Shift + I
        if (e.ctrlKey && e.shiftKey && (e.key === 'i' || e.key === 'I')) {
          e.preventDefault();
          return false;
        }

        // Ctrl + Shift + J
        if (e.ctrlKey && e.shiftKey && (e.key === 'j' || e.key === 'J')) {
          e.preventDefault();
          return false;
        }

        // Ctrl + U (View Source)
        if (e.ctrlKey && (e.key === 'u' || e.key === 'U')) {
          e.preventDefault();
          return false;
        }

        // Ctrl + Shift + C (Inspect Element)
        if (e.ctrlKey && e.shiftKey && (e.key === 'c' || e.key === 'C')) {
          e.preventDefault();
          return false;
        }
      }

      // Ctrl + A (Select All)
      if (e.ctrlKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        return false;
      }

      // Ctrl + C (Copy) - Allow in some cases but monitor
      if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        return false;
      }
    };

    // ===== DevTools Detection =====
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

    // ===== Visibility Change - Clear Clipboard =====
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        navigator.clipboard?.writeText?.('').catch(() => {});
      }
    };

    // ===== Prevent Drag & Drop =====
    const handleDragStart = (e: DragEvent) => {
      e.preventDefault();
      return false;
    };

    // ===== Setup Event Listeners =====
    document.addEventListener('contextmenu', handleContextMenu, true);
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('keyup', handleKeyDown, true);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('dragstart', handleDragStart, true);
    window.addEventListener('resize', detectDevTools);
    
    // Check DevTools periodically
    intervalRef.current = setInterval(detectDevTools, 1000);
    detectDevTools();

    // ===== Cleanup =====
    return () => {
      const watermark = document.getElementById('dynamic-watermark');
      if (watermark && document.body.contains(watermark)) {
        document.body.removeChild(watermark);
      }
      
      document.body.classList.remove('screen-protected');
      document.body.classList.remove('devtools-open');
      
      if (document.head.contains(style)) {
        document.head.removeChild(style);
      }
      
      document.removeEventListener('contextmenu', handleContextMenu, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('keyup', handleKeyDown, true);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('dragstart', handleDragStart, true);
      window.removeEventListener('resize', detectDevTools);
      
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
      
      const blockedOverlay = document.getElementById('screen-capture-blocked');
      if (blockedOverlay && document.body.contains(blockedOverlay)) {
        document.body.removeChild(blockedOverlay);
      }
    };
  }, [showWatermark, getStudentInfo, showBlockedMessage, blockDevTools]);
};

