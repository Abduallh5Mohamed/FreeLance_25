import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ShieldAlert } from 'lucide-react';

interface ProtectedVideoSurfaceProps {
  children: ReactNode;
  className?: string;
  label?: string;
}

type StoredIdentity = {
  id?: string | number;
  name?: string;
  full_name?: string;
  phone?: string;
  email?: string;
};

function readViewerIdentity() {
  for (const key of ['currentStudent', 'currentUser', 'user']) {
    try {
      const value = localStorage.getItem(key);
      if (!value) continue;
      const parsed = JSON.parse(value) as StoredIdentity;
      return {
        name: parsed.name || parsed.full_name || parsed.email || 'مستخدم المنصة',
        id: String(parsed.phone || parsed.id || '').slice(-8),
      };
    } catch {
      // Try the next stored identity.
    }
  }
  return { name: 'مستخدم المنصة', id: '' };
}

/** Browser-side capture deterrence. Guaranteed OS-level blackout requires DRM. */
export function ProtectedVideoSurface({ children, className = '', label }: ProtectedVideoSurfaceProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [covered, setCovered] = useState(false);
  const [clock, setClock] = useState(() => new Date());
  const viewer = useMemo(readViewerIdentity, []);

  const pauseVideos = useCallback(() => {
    rootRef.current?.querySelectorAll('video').forEach(video => video.pause());
  }, []);

  const cover = useCallback(() => {
    pauseVideos();
    setCovered(true);
  }, [pauseVideos]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') cover();
    };
    const onBlur = () => cover();
    const onFocus = () => setCovered(false);
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const captureShortcut = key === 'printscreen'
        || ((event.metaKey || event.ctrlKey) && event.shiftKey && key === 's');
      const saveOrPrint = (event.metaKey || event.ctrlKey) && (key === 's' || key === 'p');
      if (!captureShortcut && !saveOrPrint) return;
      event.preventDefault();
      event.stopPropagation();
      cover();
    };
    const onContextMenu = (event: MouseEvent) => event.preventDefault();
    const onPageHide = () => cover();
    const root = rootRef.current;

    document.addEventListener('visibilitychange', onVisibility, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onBlur, true);
    window.addEventListener('focus', onFocus, true);
    window.addEventListener('pagehide', onPageHide, true);
    root?.addEventListener('contextmenu', onContextMenu);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onBlur, true);
      window.removeEventListener('focus', onFocus, true);
      window.removeEventListener('pagehide', onPageHide, true);
      root?.removeEventListener('contextmenu', onContextMenu);
    };
  }, [cover]);

  const watermark = [viewer.name, viewer.id, clock.toLocaleString('ar-EG')].filter(Boolean).join(' • ');

  return (
    <div
      ref={rootRef}
      className={`protected-video-surface relative overflow-hidden bg-black select-none ${className}`}
      onDragStart={event => event.preventDefault()}
      onCopy={event => event.preventDefault()}
    >
      {children}
      <div aria-hidden className="pointer-events-none absolute inset-0 z-[70] overflow-hidden">
        {Array.from({ length: 12 }).map((_, index) => (
          <span
            key={index}
            className="absolute whitespace-nowrap text-[11px] font-semibold text-white/20"
            style={{
              left: `${(index % 3) * 34 - 8}%`,
              top: `${Math.floor(index / 3) * 27 + 5}%`,
              transform: `rotate(-25deg) translateX(${(clock.getSeconds() + index * 7) % 24}px)`,
            }}
          >
            {watermark}
          </span>
        ))}
      </div>
      {covered && (
        <div className="absolute inset-0 z-[100] flex flex-col items-center justify-center bg-black text-white" role="alert">
          <ShieldAlert className="mb-3 h-12 w-12 text-amber-400" />
          <p className="font-bold">تم إخفاء الفيديو لحماية المحتوى</p>
          <p className="mt-1 text-xs text-white/60">ارجع إلى نافذة المنصة للمتابعة{label ? ` — ${label}` : ''}</p>
        </div>
      )}
    </div>
  );
}
