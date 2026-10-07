import type { BrowserContext, Page } from "@playwright/test";

/*
 * One finger on the page. Chromium drives real touch through CDP, so the
 * browser's own scrolling, touch-action and pointer capture apply. WebKit has
 * no touch input in Playwright, so there the finger dispatches touch-typed
 * pointer events (and the click a tap ends in): they reach every pointer
 * listener the same way, but the browser does not scroll for them, and the
 * page's pointer capture for them is emulated (`emulatePointerCapture`). Like
 * a touch pointer, they stay with the element first pressed until it leaves
 * the page.
 */

export type Point = { x: number; y: number };

/** The synthetic finger's pointer id. */
const SYNTHETIC_POINTER_ID = 41;

/**
 * Pointer capture for the synthetic finger: no real pointer is active, so the
 * browser would refuse `setPointerCapture`. This keeps the capture the page
 * asks for (the finger then targets the capturing element) and leaves every
 * other pointer to the browser.
 */
function emulatePointerCapture(): void {
  const w = window as unknown as {
    __capture?: Element | null;
    __captureEmulated?: boolean;
    __release?: () => void;
  };
  if (w.__captureEmulated) return;
  w.__captureEmulated = true;
  const proto = Element.prototype;
  // The browser's own methods, for every other pointer. The id is a literal
  // here because this function runs in the page, away from its module.
  type Native = (this: Element, id: number) => boolean | undefined;
  const set = Reflect.get(proto, "setPointerCapture") as Native;
  const release = Reflect.get(proto, "releasePointerCapture") as Native;
  const has = Reflect.get(proto, "hasPointerCapture") as Native;
  proto.setPointerCapture = function (this: Element, id: number) {
    if (id !== 41) {
      set.call(this, id);
      return;
    }
    w.__capture = this;
  };
  proto.releasePointerCapture = function (this: Element, id: number) {
    if (id !== 41) {
      release.call(this, id);
      return;
    }
    if (w.__capture === this) w.__capture = null;
  };
  proto.hasPointerCapture = function (this: Element, id: number) {
    return id === 41 ? w.__capture === this : Boolean(has.call(this, id));
  };
  // Like the browser, release it once a pointerup or pointercancel for that
  // pointer has been dispatched, whoever dispatched it.
  w.__release = () => {
    const captured = w.__capture;
    w.__capture = null;
    captured?.dispatchEvent(
      new PointerEvent("lostpointercapture", { bubbles: true, pointerId: 41 }),
    );
  };
  for (const type of ["pointerup", "pointercancel"]) {
    window.addEventListener(type, (event) => {
      if ((event as PointerEvent).pointerId === 41) w.__release?.();
    });
  }
}

export interface Finger {
  readonly input: "cdp-touch" | "synthetic-pointer";
  down(at: Point): Promise<void>;
  move(to: Point): Promise<void>;
  up(): Promise<void>;
  /** Moves from where the finger is to `to` in `steps` moves `stepMs` apart. */
  slide(to: Point, steps?: number, stepMs?: number): Promise<void>;
}

export async function newFinger(
  context: BrowserContext,
  page: Page,
  browserName: string,
): Promise<Finger> {
  let at: Point = { x: 0, y: 0 };
  const slide = async (
    self: Finger,
    to: Point,
    steps = 8,
    stepMs = 16,
  ): Promise<void> => {
    const from = at;
    for (let k = 1; k <= steps; k += 1) {
      await self.move({
        x: from.x + ((to.x - from.x) * k) / steps,
        y: from.y + ((to.y - from.y) * k) / steps,
      });
      await page.waitForTimeout(stepMs);
    }
  };
  if (browserName === "chromium") {
    const cdp = await context.newCDPSession(page);
    const send = (type: string, points: Point[]) =>
      cdp.send("Input.dispatchTouchEvent", {
        type: type as "touchStart" | "touchMove" | "touchEnd",
        touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: 0 })),
      });
    const finger: Finger = {
      input: "cdp-touch",
      async down(p) {
        at = p;
        await send("touchStart", [p]);
      },
      async move(p) {
        at = p;
        await send("touchMove", [p]);
      },
      async up() {
        await send("touchEnd", []);
      },
      slide: (to, steps, stepMs) => slide(finger, to, steps, stepMs),
    };
    return finger;
  }
  await page.addInitScript(emulatePointerCapture);
  await page.evaluate(emulatePointerCapture);
  const dispatch = (type: string, p: Point) =>
    page.evaluate(
      ({ type, p, id }) => {
        const w = window as unknown as {
          __finger?: { el: Element; x: number; y: number; far: boolean };
          __capture?: Element | null;
          __release?: () => void;
        };
        if (type === "pointerdown") {
          const el = document.elementFromPoint(p.x, p.y);
          if (!el) return;
          w.__finger = { el, x: p.x, y: p.y, far: false };
          w.__capture = null;
        }
        const f = w.__finger;
        if (!f) return;
        // A touch pointer goes to the element capturing it, else to the one it
        // pressed; once that leaves the page, its events hit-test again.
        if (!f.el.isConnected) {
          f.el = document.elementFromPoint(p.x, p.y) ?? document.body;
        }
        const target = w.__capture?.isConnected ? w.__capture : f.el;
        if (Math.hypot(p.x - f.x, p.y - f.y) > 10) f.far = true;
        const pressed = type !== "pointerup";
        const init = {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: id,
          pointerType: "touch",
          isPrimary: true,
          width: 20,
          height: 20,
          pressure: pressed ? 0.5 : 0,
          clientX: p.x,
          clientY: p.y,
          button: type === "pointermove" ? -1 : 0,
          buttons: pressed ? 1 : 0,
        };
        target.dispatchEvent(new PointerEvent(type, init));
        if (type === "pointerup") {
          w.__release?.();
          if (!f.far) {
            f.el.dispatchEvent(
              new MouseEvent("click", {
                bubbles: true,
                cancelable: true,
                composed: true,
                clientX: p.x,
                clientY: p.y,
                detail: 1,
              }),
            );
          }
          w.__finger = undefined;
        }
      },
      { type, p, id: SYNTHETIC_POINTER_ID },
    );
  const finger: Finger = {
    input: "synthetic-pointer",
    async down(p) {
      at = p;
      await dispatch("pointerdown", p);
    },
    async move(p) {
      at = p;
      await dispatch("pointermove", p);
    },
    async up() {
      await dispatch("pointerup", at);
    },
    slide: (to, steps, stepMs) => slide(finger, to, steps, stepMs),
  };
  return finger;
}

/** Two fingers: the first presses and drags alone, then the second joins. */
export interface TwoFingers {
  down(a: Point): Promise<void>;
  move(a: Point): Promise<void>;
  /** The second finger lands at `b` while the first is at `a`. */
  join(a: Point, b: Point): Promise<void>;
  both(a: Point, b: Point): Promise<void>;
  up(): Promise<void>;
}

export async function twoFingers(
  context: BrowserContext,
  page: Page,
  browserName: string,
): Promise<TwoFingers> {
  if (browserName === "chromium") {
    const cdp = await context.newCDPSession(page);
    const send = async (type: string, points: Point[]) => {
      await cdp.send("Input.dispatchTouchEvent", {
        type: type as "touchStart" | "touchMove" | "touchEnd",
        touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id })),
      });
    };
    return {
      down: (a) => send("touchStart", [a]),
      move: (a) => send("touchMove", [a]),
      join: (a, b) => send("touchStart", [a, b]),
      both: (a, b) => send("touchMove", [a, b]),
      up: () => send("touchEnd", []),
    };
  }
  // The first finger is e2e/finger.ts's touch pointer (with its emulated
  // capture); the second is another touch pointer, and the touch events
  // carry both, as a real pinch's do.
  const first = await newFinger(context, page, browserName);
  const second = (type: string, a: Point, b: Point | null) =>
    page.evaluate(
      ({ type, a, b }) => {
        const w = window as unknown as { __second?: Element };
        if (type === "pointerdown" && b) {
          w.__second = document.elementFromPoint(b.x, b.y) ?? document.body;
        }
        const target = w.__second ?? document.body;
        if (b) {
          target.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              composed: true,
              pointerId: 42,
              pointerType: "touch",
              isPrimary: false,
              clientX: b.x,
              clientY: b.y,
              button: type === "pointermove" ? -1 : 0,
              buttons: type === "pointerup" ? 0 : 1,
            }),
          );
        }
        const touchType =
          type === "pointerdown"
            ? "touchstart"
            : type === "pointermove"
              ? "touchmove"
              : "touchend";
        const touches = (b ? [a, b] : []).map((p, identifier) => ({
          identifier,
          clientX: p.x,
          clientY: p.y,
          target,
        }));
        const touch = new Event(touchType, { bubbles: true, cancelable: true });
        Object.defineProperty(touch, "touches", { value: touches });
        target.dispatchEvent(touch);
      },
      { type, a, b },
    );
  let at: Point = { x: 0, y: 0 };
  return {
    down: async (a) => {
      at = a;
      await first.down(a);
    },
    move: async (a) => {
      at = a;
      await first.move(a);
    },
    join: (a, b) => second("pointerdown", a, b),
    both: async (a, b) => {
      at = a;
      await first.move(a);
      await second("pointermove", a, b);
    },
    up: async () => {
      await second("pointerup", at, { x: 0, y: 0 });
      await first.up();
    },
  };
}
