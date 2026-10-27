import { useState } from "react";
import { Player, type PlayerProps } from "../../system/Player";
import { usePlayerProps } from "./usePlayerProps";

/**
 * The Player on every stage but Record. Bar form everywhere; on a phone,
 * tapping the time expands it into a Sheet-height card with the chapters.
 */
export function PlayerBar() {
  const [form, setForm] = useState<PlayerProps["form"]>("bar");
  const props = usePlayerProps(form, setForm);
  return <Player {...props} />;
}
