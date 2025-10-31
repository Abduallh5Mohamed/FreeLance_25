import { motion } from "framer-motion";
import { useMemo } from "react";

type OrbLayer = "foreground" | "midground" | "background";

type OrbConfig = {
  id: number;
  size: number;
  x: number;
  y: number;
  duration: number;
  delay: number;
  driftX: number;
  driftY: number;
  hue: number;
  saturation: number;
  layer: OrbLayer;
};

const layerSettings: Record<OrbLayer, { opacity: number; blur: number; scale: number; glow: number; speedMultiplier: number }> = {
  background: { opacity: 0.18, blur: 120, scale: 1.4, glow: 0.35, speedMultiplier: 1.6 },
  midground: { opacity: 0.3, blur: 90, scale: 1, glow: 0.5, speedMultiplier: 1 },
  foreground: { opacity: 0.5, blur: 60, scale: 0.8, glow: 0.7, speedMultiplier: 0.7 },
};

const layerOrder: OrbLayer[] = ["background", "midground", "foreground"];

interface FloatingParticlesProps {
  /**
   * Controls whether the glowing orb effect should render.
   * "landing" -> enables enhanced effect.
   * any other value -> renders nothing.
   */
  variant?: "landing" | "disabled";
}

export const FloatingParticles = ({ variant = "disabled" }: FloatingParticlesProps) => {
  if (variant !== "landing") {
    return null;
  }
  const orbs = useMemo<OrbConfig[]>(() => {
    const totalOrbs = 18;
    return Array.from({ length: totalOrbs }, (_, id) => {
      const layer = layerOrder[id % layerOrder.length];
      const layerConfig = layerSettings[layer];

      return {
        id,
        layer,
        size: Math.random() * (layer === "foreground" ? 180 : layer === "midground" ? 240 : 320) + (layer === "foreground" ? 120 : 160),
        x: Math.random() * 100,
        y: Math.random() * 100,
        duration: (Math.random() * 12 + 16) * layerConfig.speedMultiplier,
        delay: Math.random() * 6,
        driftX: (Math.random() * 220 - 110) * layerConfig.speedMultiplier,
        driftY: (Math.random() * 200 - 100) * layerConfig.speedMultiplier,
        hue: Math.random() * 20 + 170,
        saturation: Math.random() * 25 + 60,
      };
    });
  }, []);

  return (
    <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
      {orbs.map((orb) => {
        const layerConfig = layerSettings[orb.layer];
        const baseOpacity = layerConfig.opacity + Math.random() * 0.1;

        return (
          <motion.div
            key={orb.id}
            className="absolute rounded-full mix-blend-screen"
            style={{
              width: orb.size,
              height: orb.size,
              left: `${orb.x}%`,
              top: `${orb.y}%`,
              background: `radial-gradient(circle at 30% 30%, hsla(${orb.hue}, ${orb.saturation}%, ${62 + layerConfig.glow * 20}%, ${baseOpacity + 0.2}), hsla(${orb.hue}, ${orb.saturation}%, 45%, ${baseOpacity}) 55%, transparent 75%)`,
              filter: `blur(${layerConfig.blur}px) drop-shadow(0 0 ${40 + layerConfig.glow * 40}px rgba(6, 182, 212, ${0.25 + layerConfig.glow * 0.25}))`,
              transform: `translate(-50%, -50%) scale(${layerConfig.scale})`,
            }}
            initial={{
              x: 0,
              y: 0,
              opacity: baseOpacity,
              scale: layerConfig.scale,
            }}
            animate={{
              x: [0, orb.driftX, -orb.driftX * 0.6, orb.driftX * 0.35, 0],
              y: [0, orb.driftY, -orb.driftY * 0.65, orb.driftY * 0.4, 0],
              opacity: [baseOpacity, baseOpacity + 0.2, baseOpacity - 0.05, baseOpacity + 0.1, baseOpacity],
              scale: [layerConfig.scale, layerConfig.scale * 1.05, layerConfig.scale * 0.95, layerConfig.scale * 1.08, layerConfig.scale],
              rotate: [0, 10, -8, 6, -4, 0],
            }}
            transition={{
              duration: orb.duration,
              delay: orb.delay,
              repeat: Infinity,
              repeatType: "mirror",
              ease: "easeInOut",
            }}
          />
        );
      })}
    </div>
  );
};
