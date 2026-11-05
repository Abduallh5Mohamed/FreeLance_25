import { useEffect, useRef } from "react";

/** Reference poses: tug, welcome, point, cheer, wave, paper-plane, peek. */
export function ScrollCompanion() {
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = anchor.current?.parentElement;
    if (!root) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const sheet = new Image();
    sheet.src = "/landing/tab-official-scenes-v2.png";
    const identity = new Image();
    identity.src = "/landing/tab-official-identity.png";
    const hero = new Image();
    hero.src = "/landing/tab-hero-tug.png";
    const heroArt = root.querySelector<HTMLElement>(".tw-reference-art");
    const heroCable = root.querySelector<SVGPathElement>("[data-hero-cable]");
    let heroScale = 1;
    let ready = false,
      disposed = false,
      raf = 0,
      dirty = true;
    const start = performance.now();
    const stages = Array.from(
      root.querySelectorAll<HTMLElement>("[data-tab-dock]"),
    ).map((dock) => {
      const section = dock.closest("section");
      let cell = 2,
        scene = "point";
      if (section?.id === "top") {
        cell = 0;
        scene = "pull";
      } else if (section?.id === "platform") {
        cell = 1;
        scene = "welcome";
      } else if (section?.id === "how-it-works") {
        cell = 4;
        scene = "flight";
      } else if (section?.classList.contains("tw-final")) {
        cell = 5;
        scene = "peek";
      } else if (dock.closest(".tw-story-reverse")) {
        cell = 3;
        scene = "cheer";
      } else if (dock.closest(".tw-story") === root.querySelectorAll(".tw-story")[2]) {
        scene = "wave";
      }
      const canvas = document.createElement("canvas");
      canvas.className = "tw-scene";
      canvas.dataset.scene = scene;
      canvas.dataset.action = scene;
      canvas.setAttribute("aria-hidden", "true");
      dock.append(canvas);
      return {
        dock,
        canvas,
        cell,
        scene,
        top: 0,
        size: 160,
        visible: false,
        painted: false,
      };
    });
    const measure = () => {
      heroScale = (heroArt?.getBoundingClientRect().width || 550) / 550;
      stages.forEach((s) => {
        const box = s.dock.getBoundingClientRect();
        s.top = box.top + scrollY;
        s.size = Math.ceil(box.width);
        s.painted = false;
      });
      dirty = true;
    };
    const draw = (s: (typeof stages)[number]) => {
      if (!ready || s.painted) return;
      const size = s.size,
        dpr = Math.min(devicePixelRatio || 1, 2);
      s.canvas.width = s.canvas.height = size * dpr;
      const ctx = s.canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      // Reuse original artwork for existing poses: never regenerate the face.
      const cellWidth = identity.naturalWidth / 2;
      const cellHeight = identity.naturalHeight / 2;
      const original =
        s.scene === "wave" || s.scene === "welcome"
          ? [0, 0, cellWidth, cellHeight]
          : s.scene === "point"
          ? [cellWidth, 0, cellWidth, cellHeight]
          : s.scene === "cheer"
            ? [0, cellHeight, cellWidth, cellHeight]
            : s.scene === "peek"
              ? [cellWidth, cellHeight, cellWidth, cellHeight]
              : null;
      if (s.scene === "pull") {
        ctx.drawImage(hero, 0, 0, size, size);
        // Visible rope between the two closed gloves; the external path meets
        // the right glove in the same illustration coordinate plane.
        ctx.beginPath();
        ctx.moveTo(size * .535, size * .606);
        ctx.lineTo(size * .73, size * .55);
        ctx.strokeStyle = "#1354ef";
        ctx.lineWidth = Math.max(1.2, size * .009);
        ctx.stroke();
      } else if (original) {
        const [sx, sy, sw, sh] = original;
        const height = (size * sh) / sw;
        ctx.drawImage(identity, sx, sy, sw, sh, 0, size - height, size, height);
      } else {
        ctx.drawImage(
          sheet,
          (s.cell % 2) * 512,
          Math.floor(s.cell / 2) * 512,
          512,
          512,
          0,
          0,
          size,
          size,
        );
      }
      s.painted = true;
    };
    const tick = (now: number) => {
      if (disposed) return;
      const time = (now - start) / 1000;
      if (dirty) {
        root.style.setProperty(
          "--tw-gather",
          String(reduced.matches ? 0 : Math.min(1, scrollY / 350)),
        );
        dirty = false;
      }
      stages.forEach((s) => {
        draw(s);
        if (!s.visible) return;
        const progress = Math.max(
          0,
          Math.min(1, (scrollY + innerHeight - s.top) / (innerHeight + 180)),
        );
        let x = 0,
          y = 0,
          r = 0;
        if (!reduced.matches) {
          if (s.scene === "pull") {
            x = -Math.sin(time * 1.6) * 3 * heroScale;
          }
          if (s.scene === "welcome") {
            r = Math.sin(time * 1.1) * 1.5;
            y = Math.sin(time * 1.1) * 1.5;
          }
          if (s.scene === "point" || s.scene === "wave") {
            r = Math.sin(time * 1.4) * 2;
          }
          if (s.scene === "cheer") {
            y = -Math.max(0, Math.sin(time * 2)) * 8;
            r = Math.sin(time * 2) * 3;
          }
          if (s.scene === "flight") {
            x = progress * (innerWidth < 700 ? 36 : 80);
            y = Math.sin(time * 1.5) * 4;
            r = Math.sin(time * 1.5) * 3;
          }
          if (s.scene === "peek") {
            x = Math.sin(time * 0.8) * 5;
            r = Math.sin(time * 0.8) * 2;
          }
        }
        if (s.scene === "pull") {
          const handX = 245 + x / heroScale;
          heroCable?.setAttribute(
            "d",
            `M${handX} 230 C${handX + 28} 228 345 242 400 246`,
          );
        }
        s.canvas.style.transform = `translate3d(${x}px,${y}px,0) rotate(${r}deg)`;
        s.canvas.dataset.frame = String(Math.round(time * 10));
      });
      if (!document.hidden && !reduced.matches)
        raf = requestAnimationFrame(tick);
    };
    const restart = () => {
      cancelAnimationFrame(raf);
      dirty = true;
      if (!document.hidden) raf = requestAnimationFrame(tick);
    };
    const scroll = () => {
      dirty = true;
      if (reduced.matches) restart();
    };
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          const stage = stages.find((s) => s.dock === e.target);
          if (stage) stage.visible = e.isIntersecting;
        });
        restart();
      },
      { rootMargin: "80px" },
    );
    stages.forEach((s) => observer.observe(s.dock));
    const resize = new ResizeObserver(measure);
    resize.observe(root);
    measure();
    Promise.all([sheet.decode(), identity.decode(), hero.decode()])
      .then(() => {
        if (!disposed) {
          ready = true;
          restart();
        }
      })
      .catch(() => {});
    document.fonts.ready.then(() => {
      if (!disposed) measure();
    });
    addEventListener("resize", measure);
    addEventListener("scroll", scroll, { passive: true });
    document.addEventListener("visibilitychange", restart);
    reduced.addEventListener("change", restart);
    restart();
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      resize.disconnect();
      stages.forEach((s) => s.canvas.remove());
      removeEventListener("resize", measure);
      removeEventListener("scroll", scroll);
      document.removeEventListener("visibilitychange", restart);
      reduced.removeEventListener("change", restart);
    };
  }, []);
  return <div ref={anchor} aria-hidden="true" />;
}
