import { useState } from "react";
import { Player } from "../../system/Player";
import { usePlayerProps } from "./usePlayerProps";

/**
 * The Player on every stage but Record. The bar form on a phone expands on a
 * tap of the time into a Sheet-height card with the chapters; the `dock`
 * placement (phone guest Review) never expands.
 */
export function PlayerBar({
  placement = "bar",
}: {
  placement?: "bar" | "dock";
}) {
  const [expanded, setExpanded] = useState(false);
  const form = placement === "dock" ? "dock" : expanded ? "expanded" : "bar";
  const props = usePlayerProps(form, (next) =>
    setExpanded(next === "expanded"),
  );
  return <Player {...props} />;
}
