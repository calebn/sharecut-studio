const NAMING_ATTRIBUTES = [
  "aria-label",
  "title",
  "placeholder",
  "aria-description",
];

/** Everything a person reads or hears in `root`: its text and its naming attributes. */
export function readableText(root: HTMLElement): string[] {
  const out: string[] = [];
  const text = root.textContent?.trim();
  if (text) out.push(text);
  for (const el of [root, ...root.querySelectorAll("*")]) {
    for (const attribute of NAMING_ATTRIBUTES) {
      const value = el.getAttribute(attribute)?.trim();
      if (value) out.push(value);
    }
  }
  return out;
}
