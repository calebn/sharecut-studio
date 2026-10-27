/** A token's resolved block size in px: a `calc()` of tokens included. */
export function tokenHeightPx(host: HTMLElement, token: string): number {
  const probe = document.createElement("div");
  probe.style.cssText = `position:absolute;visibility:hidden;inline-size:0;block-size:var(${token})`;
  host.appendChild(probe);
  const px = probe.getBoundingClientRect().height;
  probe.remove();
  return px;
}
