/**
 * Source scans of JSX host elements, for governance tests: each element is
 * the text from its `<tag ` to the next one, so an attribute belongs to the
 * nearest element opened before it.
 */
export interface JsxElement {
  /** 1-based line of its `<tag`. */
  line: number;
  text: string;
}

export function jsxElements(source: string): JsxElement[] {
  const starts = [...source.matchAll(/<[a-z][a-z0-9]*\s/g)].map(
    (match) => match.index ?? 0,
  );
  return starts.map((start, i) => ({
    line: source.slice(0, start).split("\n").length,
    text: source.slice(start, starts[i + 1] ?? source.length),
  }));
}

/**
 * The element owns a pointer press, so it can start a drag: an
 * `onPointerDown` prop, or a spread bag of handlers or pointer/press props.
 */
export function ownsPointerDown(element: JsxElement): boolean {
  return /\bonPointerDown(Capture)?=\{|\{\.\.\.[\w.?]*(?:[hH]andlers|[pP]ointerProps|[pP]ressProps)\}/.test(
    element.text,
  );
}

/**
 * Hit kinds the element marks itself with: the string literals in the first
 * argument of each `hitTargetProps(…)`, a ternary's branches included.
 */
export function markedKinds(element: JsxElement): string[] {
  return [...element.text.matchAll(/hitTargetProps\(([^,]+),/g)].flatMap(
    ([, kind]) => [...kind.matchAll(/"([a-z-]+)"/g)].map((match) => match[1]),
  );
}

/** The element is a plain hit surface behind the targets. */
export function marksSurface(element: JsxElement): boolean {
  return element.text.includes("HIT_SURFACE_PROPS");
}
