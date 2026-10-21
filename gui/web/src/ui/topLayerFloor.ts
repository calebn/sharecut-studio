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
  if (floor?.isConnected && floorShown) {
    floor.hidePopover();
  }
  floorShown = false;
}

function settleFloor(): void {
  // A region React already detached is no longer in the document: the browser
  // hid it, and showing or hiding it would throw and unmount the app.
  if (!floor?.isConnected || !supportsPopover(floor)) {
    floorShown = false;
    return;
  }
  hideFloor();
  if (panelsOpen > 0) {
    if (!floor.hasAttribute("popover")) {
      floor.setAttribute("popover", "manual");
    }
    floor.showPopover();
    floorShown = true;
  } else {
    floor.removeAttribute("popover");
  }
}

/** The toast region rides above open menu panels (as a manual popover) until released. */
export function claimTopLayerFloor(region: HTMLElement): () => void {
  floor = region;
  settleFloor();
  return () => {
    if (floor === region) {
      hideFloor();
      region.removeAttribute("popover");
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

export function popoverSupported(): boolean {
  const proto =
    typeof window === "undefined" ? null : window.HTMLElement.prototype;
  return (
    typeof proto?.showPopover === "function" &&
    typeof proto.hidePopover === "function"
  );
}

/**
 * Put `panel` (rendered with `popover="manual"`) in the top layer and keep the
 * toast above it; the returned cleanup hides it again. Every floating overlay
 * that is not a modal `Dialog` goes through here: `Menu`, the create menu and
 * the target chooser.
 */
export function showInTopLayer(panel: HTMLElement): () => void {
  panel.showPopover();
  const leave = enterTopLayerPanel();
  return () => {
    leave();
    // A panel that React already detached was hidden by the browser, and
    // `hidePopover()` would throw on it and unmount the app.
    if (panel.isConnected) {
      panel.hidePopover();
    }
  };
}
