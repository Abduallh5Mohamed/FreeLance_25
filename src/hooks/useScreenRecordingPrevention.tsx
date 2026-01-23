import { useEffect, useCallback } from 'react';

export const useScreenRecordingPrevention = () => {
  const showBlockedMessage = useCallback(() => {
    // Create a black overlay that covers the screen
    const overlay = document.createElement('div');
    overlay.id = 'screen-capture-blocked';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: #000;
      z-index: 999999;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      color: white;
      font-size: 24px;
      font-family: Arial, sans-serif;
    `;
    overlay.innerHTML = `
      <div style="text-align: center; padding: 40px;">
        <div style="font-size: 60px; margin-bottom: 20px;">🚫</div>
        <h2 style="margin-bottom: 15px;">تم اكتشاف محاولة تسجيل الشاشة!</h2>
        <p style="opacity: 0.8; font-size: 18px;">لأسباب أمنية، لا يمكن تصوير هذه الصفحة</p>
        <p style="opacity: 0.6; font-size: 14px; margin-top: 20px;">سيتم إزالة هذه الرسالة خلال ثوانٍ...</p>
      </div>
    `;
    document.body.appendChild(overlay);
    
    // Remove after 3 seconds
    setTimeout(() => {
      if (document.body.contains(overlay)) {
        document.body.removeChild(overlay);
      }
    }, 3000);
  }, []);

  useEffect(() => {
    // ===== CSS to hide content when captured =====
    const style = document.createElement('style');
    style.id = 'screen-capture-prevention-styles';
    style.textContent = `
      /* Hide content in screenshots on supported browsers */
      @media screen and (display-mode: browser) {
        .screen-protected {
          -webkit-user-select: none !important;
          -moz-user-select: none !important;
          -ms-user-select: none !important;
          user-select: none !important;
        }
      }
      
      /* Blur content when printing */
      @media print {
        body * {
          visibility: hidden !important;
        }
        body::after {
          content: "المحتوى محمي - لا يمكن طباعته";
          visibility: visible !important;
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          font-size: 24px;
          color: #333;
        }
      }

      /* Disable text selection on protected elements */
      .screen-protected * {
        -webkit-touch-callout: none;
        -webkit-user-select: none;
        -khtml-user-select: none;
        -moz-user-select: none;
        -ms-user-select: none;
        user-select: none;
      }
    `;
    document.head.appendChild(style);

    // Add screen-protected class to body
    document.body.classList.add('screen-protected');

    // ===== Prevent right-click context menu =====
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      return false;
    };

    // ===== Prevent keyboard shortcuts for screenshots =====
    const handleKeyDown = (e: KeyboardEvent) => {
      // Prevent Print Screen
      if (e.key === 'PrintScreen' || e.code === 'PrintScreen') {
        e.preventDefault();
        navigator.clipboard.writeText('');
        showBlockedMessage();
        return false;
      }

      // Prevent Windows + Shift + S (Windows Snipping Tool)
      if (e.metaKey && e.shiftKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        showBlockedMessage();
        return false;
      }

      // Prevent Ctrl+Shift+S
      if (e.ctrlKey && e.shiftKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        showBlockedMessage();
        return false;
      }

      // Prevent Ctrl+P (print)
      if (e.ctrlKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        showBlockedMessage();
        return false;
      }

      // Prevent F12 (DevTools)
      if (e.key === 'F12') {
        e.preventDefault();
        return false;
      }

      // Prevent Ctrl+Shift+I (DevTools)
      if (e.ctrlKey && e.shiftKey && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault();
        return false;
      }

      // Prevent Ctrl+U (View Source)
      if (e.ctrlKey && (e.key === 'u' || e.key === 'U')) {
        e.preventDefault();
        return false;
      }
    };

    // ===== Detect Screen Recording using Permission API =====
    const checkScreenCapture = async () => {
      try {
        // Check if display capture is being used
        if ('getDisplayMedia' in navigator.mediaDevices) {
          const devices = await navigator.mediaDevices.enumerateDevices();
          // This is a basic check - full detection requires more advanced methods
        }
      } catch (error) {
        // Ignore errors
      }
    };

    // ===== Visibility Change Detection =====
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        // Clear clipboard when page is hidden (potential screenshot)
        navigator.clipboard.writeText('').catch(() => {});
      }
    };

    // ===== Add watermark overlay =====
    const watermark = document.createElement('div');
    watermark.id = 'protection-watermark';
    watermark.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 9999;
      opacity: 0.03;
      background: repeating-linear-gradient(
        45deg,
        transparent,
        transparent 100px,
        rgba(0, 0, 0, 0.05) 100px,
        rgba(0, 0, 0, 0.05) 200px
      );
    `;
    watermark.innerHTML = `
      <div style="
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%) rotate(-45deg);
        font-size: 80px;
        font-weight: bold;
        color: rgba(0, 0, 0, 0.03);
        white-space: nowrap;
        pointer-events: none;
      ">
        محمي © منصة القائد
      </div>
    `;
    
    document.body.appendChild(watermark);
    document.addEventListener('contextmenu', handleContextMenu);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyDown);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Check for screen capture periodically
    const captureCheckInterval = setInterval(checkScreenCapture, 5000);

    // ===== Cleanup =====
    return () => {
      if (document.body.contains(watermark)) {
        document.body.removeChild(watermark);
      }
      document.body.classList.remove('screen-protected');
      if (document.head.contains(style)) {
        document.head.removeChild(style);
      }
      document.removeEventListener('contextmenu', handleContextMenu);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyDown);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearInterval(captureCheckInterval);
      
      // Remove blocked message if exists
      const blockedOverlay = document.getElementById('screen-capture-blocked');
      if (blockedOverlay) {
        document.body.removeChild(blockedOverlay);
      }
    };
  }, [showBlockedMessage]);
};

