/**
 * One layering model for floating UI. A `Menu` panel is a popover, so the
 * browser draws it in the top layer, above every z-index (`--z-*`), and among
 * top-layer elements the one shown last is on top. The app toast keeps its
 * `--z-toast` stacking until a menu panel is open: it then claims the top
 * layer and is re-shown after each panel opens, so a visible toast stays above
 * the menu and its Undo stays tappable, whichever came first. Without the
 * Popover API every layer is a fixed element, and `--z-toast` over `--z-menu`
 * already gives the same order.
 */
let floor: HTMLElement | null = null;
let floorShown = false;
let panelsOpen = 0;

function supportsPopover(el: HTMLElement): boolean {
  return typeof el.showPopover === "function";
}

function hideFloor(): void {
  if (floor && floorShown) {
    floor.hidePopover();
    floor.removeAttribute("popover");
  }
  floorShown = false;
}

function settleFloor(): void {
  if (!floor || !supportsPopover(floor)) {
    return;
  }
  hideFloor();
  if (panelsOpen > 0) {
    floor.setAttribute("popover", "manual");
    floor.showPopover();
    floorShown = true;
  }
}

/** The toast region rides above open menu panels (as a manual popover) until released. */
export function claimTopLayerFloor(region: HTMLElement): () => void {
  floor = region;
  settleFloor();
  return () => {
    if (floor === region) {
      hideFloor();
      floor = null;
    }
  };
}

/** Call right after a panel's `showPopover()`; the result leaves when it hides. */
export function enterTopLayerPanel(): () => void {
  panelsOpen += 1;
  settleFloor();
  return () => {
    panelsOpen -= 1;
    settleFloor();
  };
}
