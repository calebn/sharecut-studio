import { Player } from "../../system/Player";
import { usePlayerProps } from "./usePlayerProps";

const NOOP = () => {};

/** The expanded Player with no collapse control: the card is the form on this page. */
export function GuestPlayerCard() {
  const props = usePlayerProps("expanded", NOOP);
  return <Player {...props} onCollapse={undefined} onExpand={undefined} />;
}
