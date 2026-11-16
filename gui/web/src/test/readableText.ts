const NAMING_ATTRIBUTES = [
  "aria-label",
  "title",
  "placeholder",
  "aria-description",
];

/** A screen reader speaks the naming attributes and a tooltip shows `title`, so a copy rule has to read them as well as the text. */
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

/** The strings in `root` that still name the room list "Notes". */
export function notesNaming(root: HTMLElement): string[] {
  return readableText(root).filter((text) => /\bnotes?\b/i.test(text));
}
