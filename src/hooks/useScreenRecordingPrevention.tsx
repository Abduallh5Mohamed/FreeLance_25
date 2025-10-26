import { useEffect } from 'react';

export const useScreenRecordingPrevention = () => {
  useEffect(() => {
    // Prevent right-click context menu
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      return false;
    };

    // Prevent print screen key
    const handleKeyDown = (e: KeyboardEvent) => {
      // Prevent Print Screen
      if (e.key === 'PrintScreen') {
        e.preventDefault();
        navigator.clipboard.writeText('');
        return false;
      }

      // Prevent Ctrl+Shift+S (screenshot in some browsers)
      if (e.ctrlKey && e.shiftKey && e.key === 'S') {
        e.preventDefault();
        return false;
      }

      // Prevent Ctrl+P (print)
      if (e.ctrlKey && e.key === 'p') {
        e.preventDefault();
        return false;
      }
    };

    // Add watermark overlay to discourage recording
    const watermark = document.createElement('div');
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
    watermark.textContent = 'محمي © منصة القائد';
    watermark.style.fontSize = '50px';
    watermark.style.display = 'flex';
    watermark.style.alignItems = 'center';
    watermark.style.justifyContent = 'center';
    watermark.style.fontWeight = 'bold';
    
    document.body.appendChild(watermark);
    document.addEventListener('contextmenu', handleContextMenu);
    document.addEventListener('keydown', handleKeyDown);

    // Cleanup
    return () => {
      document.body.removeChild(watermark);
      document.removeEventListener('contextmenu', handleContextMenu);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);
};
