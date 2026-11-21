import { useCallback, useMemo, useRef, useState } from "react";
import type { GuestScriptModel } from "../../stage/hosts/guestScript";
import type { ScriptPaneReadingPosition } from "../../system/ScriptPane";
import {
  captureReading,
  type GuestBookmark,
  rebaseReading,
} from "./rebaseReading";

export type GuestReading = {
  following: boolean;
  getPosition: (
    model: GuestScriptModel,
  ) => ReturnType<typeof rebaseReading> | null;
  setFollowing: (following: boolean) => void;
  capture: (
    position: ScriptPaneReadingPosition,
    model: GuestScriptModel,
  ) => void;
};

export function useGuestReading(controlled?: GuestReading): GuestReading {
  const [following, setFollowingState] = useState(true);
  const position = useRef<GuestBookmark | null>(null);
  const getPosition = useCallback(
    (model: GuestScriptModel) =>
      position.current && rebaseReading(position.current, model),
    [],
  );
  const setFollowing = useCallback((next: boolean) => {
    if (next) position.current = null;
    setFollowingState(next);
  }, []);
  const capture = useCallback(
    (next: ScriptPaneReadingPosition, model: GuestScriptModel) => {
      position.current = captureReading(next, model);
    },
    [],
  );
  const local = useMemo(
    () => ({ following, getPosition, setFollowing, capture }),
    [following, getPosition, setFollowing, capture],
  );
  return controlled ?? local;
}
