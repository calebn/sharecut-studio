export const NEAREST = 820;
export const CENTER = 910;

export function probeScript(body: HTMLElement, wordTop = 1000) {
  const calls: [string | null, number][] = [];
  let readMeasuredText: () => string | null = () => null;
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
      calls.push([readMeasuredText(), value]);
    },
  });
  const original: TypedPropertyDescriptor<Element["getBoundingClientRect"]> =
    Object.getOwnPropertyDescriptor(
      Element.prototype,
      "getBoundingClientRect",
    )!;
  Object.defineProperty(Element.prototype, "getBoundingClientRect", {
    ...original,
    value: function (this: Element) {
      if (this === body) return new DOMRect(0, 0, 100, 200);
      readMeasuredText = () => this.textContent;
      return new DOMRect(0, wordTop, 100, 20);
    },
  });
  return {
    calls,
    clear: () => {
      calls.length = 0;
      scrollTop = 0;
    },
    restore: () => {
      Object.defineProperty(
        Element.prototype,
        "getBoundingClientRect",
        original,
      );
    },
  };
}
