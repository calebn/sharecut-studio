import { useLayoutEffect } from "react";
import type { SheetHost } from "./useSheetHost";

/**
 * Places the host and sets what it is: the sheet's `.bottom-sheet-root` on
 * `<body>`, or a box-less parent in the shell's grid, right after `<main>`
 * (inert while a sheet is stowed). It renders first inside the portal, so the
 * host is in the document before the sheet's own layout effects run. A move
 * blurs whatever the browser had focused inside, so focus returns to it, the
 * body keeps its scroll offset, and the field is revealed.
 */
export function SheetHostPlacement({
  host,
  column,
  stowed,
}: {
  host: SheetHost;
  column: boolean;
  stowed: boolean;
}) {
  useLayoutEffect(() => {
    host.place(column, stowed);
  }, [host, column, stowed]);
  useLayoutEffect(() => () => host.detach(), [host]);
  return null;
}
