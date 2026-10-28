/**
 * Test support: watches the Script body's own scrolling. Every word reports a
 * rect far below a 200px view, so a "nearest" follow lands on `NEAREST` and a
 * "center" follow on `CENTER`, and the word scrolled to is the last element
 * measured before the body's scrollTop was set.
 */
export const NEAREST = 820;
export const CENTER = 910;

export function probeScript(body: HTMLElement) {
  const calls: [string | null, number][] = [];
  let measured: Element | undefined;
  let scrollTop = 0;
  Object.defineProperty(body, "clientHeight", {
    configurable: true,
    value: 200,
  });
  Object.defineProperty(body, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
      calls.push([measured?.textContent ?? null, value]);
    },
  });
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this === body) return new DOMRect(0, 0, 100, 200);
    measured = this;
    return new DOMRect(0, 1000, 100, 20);
  };
  return {
    calls,
    clear: () => {
      calls.length = 0;
      scrollTop = 0;
    },
    restore: () => {
      Element.prototype.getBoundingClientRect = original;
    },
  };
}
