import { useEffect, useRef } from 'react';

const COLORS = ['#2a78d6', '#1baf7a', '#eda100', '#eb6834', '#e87ba4', '#6250d6'];

/**
 * Kort, letvægts konfettiudbrud på et canvas (ingen afhængigheder).
 * Respekterer "reducer bevægelse" – så vises intet.
 */
export function Confetti({ onDone, duration = 2200 }: { onDone?: () => void; duration?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { onDone?.(); return; }
    const c = ref.current!;
    const ctx = c.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    const resize = () => { c.width = innerWidth * dpr; c.height = innerHeight * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    resize();
    // To "kanoner" fra bunden af skærmen, der skyder ind mod midten.
    const parts = Array.from({ length: 160 }, (_, i) => {
      const left = i % 2 === 0;
      const angle = (left ? -60 : -120) + (Math.random() - 0.5) * 40;
      const speed = 9 + Math.random() * 9;
      return {
        x: left ? innerWidth * 0.15 : innerWidth * 0.85,
        y: innerHeight + 10,
        vx: Math.cos((angle * Math.PI) / 180) * speed,
        vy: Math.sin((angle * Math.PI) / 180) * speed * 1.6,
        w: 6 + Math.random() * 6,
        h: 3 + Math.random() * 4,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
        color: COLORS[i % COLORS.length],
      };
    });
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = now - start;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      const fade = Math.max(0, 1 - Math.max(0, t - duration * 0.6) / (duration * 0.4));
      for (const p of parts) {
        p.vy += 0.32; // tyngdekraft
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.rot * 2)) + 1);
        ctx.restore();
      }
      if (t < duration) raf = requestAnimationFrame(tick);
      else onDone?.();
    };
    raf = requestAnimationFrame(tick);
    window.addEventListener('resize', resize);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }, []);
  return <canvas ref={ref} aria-hidden style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: 200 }} />;
}
