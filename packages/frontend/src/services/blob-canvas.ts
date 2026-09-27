/**
 * Animated blob background: a solid ground, seven blurred radial-gradient
 * blobs drifting on sine paths, and a pre-generated monochrome grain
 * composited in overlay mode on top. Ported from the marketing site's
 * initBlobCanvas; colors are art data (theme-independent), kept as rgb
 * triples rather than design tokens on purpose.
 *
 * Usage: an absolutely-positioned canvas filling a relative parent; call
 * initBlobCanvas(canvas) and invoke the returned cleanup on unmount.
 * Honors prefers-reduced-motion by painting a single static frame.
 */

export type Rgb = [number, number, number];

/* #295eff */
export const PIVOT_CANVAS_BG: Rgb = [41, 94, 255];
/* #3fdeb7, #f5b98c, #e89696, #fad282 */
export const PIVOT_CANVAS_PALETTE: Rgb[] = [
  [63, 222, 183],
  [245, 185, 140],
  [232, 150, 150],
  [250, 210, 130],
];

/* Dark navy for the fine text shadow that lifts white text off the canvas. */
export const PIVOT_CANVAS_INK: Rgb = [10, 18, 50];

export function cssColor(color: Rgb, alpha = 1): string {
  return `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;
}

export interface BlobCanvasOptions {
  bgColor?: Rgb;
  palette?: Rgb[];
}

const GRAIN_AMT = 160;
const GRAIN_OP = 85;
const BLUR_PX = 100;
const SPEED_MULT = 17;
const BLOB_COUNT = 7;
const SIZE_SCALE = 83;

const CONFIGS = [
  { x: -0.05, y: 1.05, phaseX: 0.0, phaseY: 0.0, speed: 0.8 },
  { x: 0.55, y: -0.15, phaseX: 1.8, phaseY: 2.2, speed: 1.1 },
  { x: 1.1, y: 0.5, phaseX: 3.2, phaseY: 1.0, speed: 0.9 },
  { x: 0.1, y: -0.1, phaseX: 0.5, phaseY: 3.5, speed: 1.3 },
  { x: 1.05, y: 1.0, phaseX: 2.6, phaseY: 0.8, speed: 0.7 },
  { x: 0.2, y: 0.45, phaseX: 4.1, phaseY: 2.0, speed: 1.0 },
  { x: 0.65, y: 1.1, phaseX: 1.2, phaseY: 4.2, speed: 0.85 },
];

/** Starts the animation; returns a cleanup that stops it and detaches listeners. */
export function initBlobCanvas(
  canvas: HTMLCanvasElement,
  opts: BlobCanvasOptions = {},
): () => void {
  const noop = () => {};
  const ctx = canvas.getContext('2d');
  if (!ctx) return noop;
  const grainCanvas = document.createElement('canvas');
  const gctx = grainCanvas.getContext('2d');
  if (!gctx) return noop;

  const bgColor = opts.bgColor ?? PIVOT_CANVAS_BG;
  const palette = opts.palette ?? PIVOT_CANVAS_PALETTE;
  const reducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let W = 0;
  let H = 0;
  let dpr = 1;
  let raf = 0;
  let stopped = false;
  let t = Math.random() * 100;

  function generateGrain() {
    const img = gctx!.createImageData(W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.random() * GRAIN_AMT;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = GRAIN_OP;
    }
    gctx!.putImageData(img, 0, 0);
  }

  function resize() {
    const parent = canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    // Render at the physical resolution (capped at 2x): a 1x backing store
    // gets upscaled on retina displays, which turns the one-pixel grain into
    // fat two-by-two speckles. The blur scales with dpr so the blobs keep
    // the same visual softness.
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.width = Math.round(rect.width * dpr);
    H = canvas.height = Math.round(rect.height * dpr);
    if (!W || !H) return;
    grainCanvas.width = W;
    grainCanvas.height = H;
    generateGrain();
    // Setting width/height just cleared the backing store. The animation
    // loop repaints on its next frame, but under reduced motion there is no
    // loop: repaint the static frame here so it tracks the new size.
    if (reducedMotion) draw();
  }

  function draw() {
    if (stopped) return;
    if (!W || !H) {
      raf = requestAnimationFrame(draw);
      return;
    }
    t += 0.005 * (SPEED_MULT / 5);
    ctx!.fillStyle = cssColor(bgColor);
    ctx!.fillRect(0, 0, W, H);
    ctx!.filter = `blur(${BLUR_PX * dpr}px)`;
    CONFIGS.slice(0, BLOB_COUNT).forEach((b, i) => {
      const color = palette[i % palette.length] ?? bgColor;
      const px = (b.x + Math.sin(t * b.speed + b.phaseX) * 0.15) * W;
      const py = (b.y + Math.cos(t * b.speed * 0.9 + b.phaseY) * 0.12) * H;
      const r = (SIZE_SCALE / 100) * W * 0.7;
      const grad = ctx!.createRadialGradient(px, py, 0, px, py, r);
      grad.addColorStop(0, cssColor(color, 0.85));
      grad.addColorStop(0.4, cssColor(color, 0.5));
      grad.addColorStop(1, cssColor(color, 0));
      ctx!.beginPath();
      ctx!.arc(px, py, r, 0, Math.PI * 2);
      ctx!.fillStyle = grad;
      ctx!.fill();
    });
    ctx!.filter = 'none';
    ctx!.globalCompositeOperation = 'overlay';
    ctx!.drawImage(grainCanvas, 0, 0);
    ctx!.globalCompositeOperation = 'source-over';
    if (!reducedMotion) raf = requestAnimationFrame(draw);
  }

  let observer: ResizeObserver | undefined;
  const onWindowResize = () => {
    // With the observer covering parent size changes, this listener only
    // needs to act on a device-pixel-ratio change; bailing otherwise avoids
    // clearing the canvas and regenerating the grain on every drag of the
    // window edge.
    if (observer && Math.min(window.devicePixelRatio || 1, 2) === dpr) return;
    resize();
  };
  if (typeof ResizeObserver === 'function' && canvas.parentElement) {
    observer = new ResizeObserver(() => resize());
    observer.observe(canvas.parentElement);
  }
  // Kept alongside the observer: moving the window to a display with a
  // different pixel ratio changes dpr without changing the parent's CSS
  // size, which the observer never reports.
  window.addEventListener('resize', onWindowResize);

  resize();
  draw();

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    observer?.disconnect();
    window.removeEventListener('resize', onWindowResize);
  };
}
