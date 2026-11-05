import { useLayoutEffect } from "react";
import type { SheetHost } from "./useSheetHost";

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
