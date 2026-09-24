/** One animation frame drives every mounted peak meter. */
type FrameListener = (now: number) => void;

const listeners = new Set<FrameListener>();
let frame = 0;

function tick(now: number): void {
  frame = 0;
  for (const listener of [...listeners]) {
    if (listeners.has(listener)) listener(now);
  }
  if (listeners.size > 0 && frame === 0) frame = requestAnimationFrame(tick);
}

export function subscribeMeterFrame(listener: FrameListener): () => void {
  listeners.add(listener);
  if (frame === 0) frame = requestAnimationFrame(tick);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  };
}
