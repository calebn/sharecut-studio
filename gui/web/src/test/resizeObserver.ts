import { vi } from "vitest";

/**
 * A controllable `ResizeObserver`: it records what it watches and reports on
 * `fire()`. `all` lists every observer built since the last
 * `stubResizeObserver()`. The one shared fake for GUI tests; do not declare a
 * local ResizeObserver class.
 */
export class FakeResizeObserver {
  static all: FakeResizeObserver[] = [];
  /** Report at once on `observe()`, as a first layout would. */
  static reportOnObserve = false;
  targets: Element[] = [];
  disconnected = false;
  private readonly cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    FakeResizeObserver.all.push(this);
  }
  observe(el: Element): void {
    this.targets.push(el);
    if (FakeResizeObserver.reportOnObserve) {
      this.fire(el);
    }
  }
  unobserve(el: Element): void {
    this.targets = this.targets.filter((t) => t !== el);
  }
  disconnect(): void {
    this.disconnected = true;
    this.targets = [];
  }
  /**
   * The observer watching `target`; throws when none does, so a missed lookup
   * fails with a clear message instead of a `TypeError` on `undefined`.
   */
  static of(target: Element): FakeResizeObserver {
    const ro = FakeResizeObserver.all.find((o) => o.targets.includes(target));
    if (!ro) {
      throw new Error(
        `no FakeResizeObserver watches <${target.tagName.toLowerCase()} class="${target.className}">`,
      );
    }
    return ro;
  }
  /** Report a resize of `target` (the first target by default); `entry` adds fields such as `contentRect`. */
  fire(
    target: Element | undefined = this.targets[0],
    entry: Partial<ResizeObserverEntry> = {},
  ): void {
    this.cb(
      [{ target, ...entry } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}

/**
 * Stub the global `ResizeObserver` with `FakeResizeObserver` and clear its
 * registry. `reportOnObserve` makes `observe()` report at once. Pair with
 * `vi.unstubAllGlobals()`.
 */
export function stubResizeObserver({
  reportOnObserve = false,
}: {
  reportOnObserve?: boolean;
} = {}): void {
  FakeResizeObserver.all = [];
  FakeResizeObserver.reportOnObserve = reportOnObserve;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
}
