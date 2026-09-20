export type CursorMotion = {
  step: (
    key: string,
    target: { left: number; top: number },
    el: HTMLElement | undefined,
    sig: string,
  ) => void;
  drop: (key: string) => void;
};

export function createCursorMotion(
  opts: { lerp?: number; idleMs?: number } = {},
): CursorMotion {
  const lerp = opts.lerp ?? 0.35;
  const idleMs = opts.idleMs ?? 3000;
  const displayed = new Map<string, { left: number; top: number }>();
  const idleAt = new Map<string, number>();
  const lastSig = new Map<string, string>();

  return {
    step(key, target, el, sig) {
      const prev = displayed.get(key) ?? target;
      const next = {
        left: prev.left + (target.left - prev.left) * lerp,
        top: prev.top + (target.top - prev.top) * lerp,
      };
      displayed.set(key, next);
      if (el) {
        el.style.left = `${next.left}px`;
        el.style.top = `${next.top}px`;
      }
      if (lastSig.get(key) !== sig) {
        lastSig.set(key, sig);
        idleAt.set(key, Date.now());
        el?.classList.remove("is-idle");
      } else if (Date.now() - (idleAt.get(key) ?? 0) > idleMs) {
        el?.classList.add("is-idle");
      }
    },
    drop(key) {
      displayed.delete(key);
      idleAt.delete(key);
      lastSig.delete(key);
    },
  };
}
