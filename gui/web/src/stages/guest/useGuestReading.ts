import { useCallback, useMemo, useRef, useState } from "react";
import type { ScriptPaneReadingPosition } from "../../system/ScriptPane";

export type GuestReading = {
  following: boolean;
  getPosition: () => ScriptPaneReadingPosition | null;
  setFollowing: (following: boolean) => void;
  capture: (position: ScriptPaneReadingPosition) => void;
};

export function useGuestReading(controlled?: GuestReading): GuestReading {
  const [following, setFollowingState] = useState(true);
  const position = useRef<ScriptPaneReadingPosition | null>(null);
  const getPosition = useCallback(() => position.current, []);
  const setFollowing = useCallback((next: boolean) => {
    if (next) position.current = null;
    setFollowingState(next);
  }, []);
  const capture = useCallback((next: ScriptPaneReadingPosition) => {
    position.current = next;
  }, []);
  const local = useMemo(
    () => ({ following, getPosition, setFollowing, capture }),
    [following, getPosition, setFollowing, capture],
  );
  return controlled ?? local;
}
