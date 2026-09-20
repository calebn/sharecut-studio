/** Non-reactive gate so open menus suppress Daw keymap shortcuts. */
let openMenuCount = 0;

export function noteMenuOpen(open: boolean): void {
  if (open) {
    openMenuCount += 1;
  } else {
    openMenuCount = Math.max(0, openMenuCount - 1);
  }
}

export function peekMenuOpen(): boolean {
  return openMenuCount > 0;
}
