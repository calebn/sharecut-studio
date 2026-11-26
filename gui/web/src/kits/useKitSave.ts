import { useCallback, useEffect, useRef, useState } from "react";
import {
  type KitSaveRefusal,
  type KitSaveRequest,
  type KitSaveResult,
  kitSaveRefusal,
  saveKit,
} from "../api";
import { kitSaveMessage } from "./kitSaveMessages";

/** How the request reaches the studio; stories stand in a fake. */
export type KitSender = (request: KitSaveRequest) => Promise<KitSaveResult>;

export type KitSaveState = {
  saving: boolean;
  /** What the last save failed with; cleared when the next one starts. */
  failure: string | null;
  /** The refusal code behind `failure`, when the studio gave one the sheet knows. */
  refusal: KitSaveRefusal | null;
  /** The reply, or null when the save failed (see `failure`) or one is already running. */
  save: (request: KitSaveRequest) => Promise<KitSaveResult | null>;
  clearFailure: () => void;
};

/** One kit save at a time; a second call while one runs is ignored. */
export function useKitSave(send: KitSender = saveKit): KitSaveState {
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<KitSaveRefusal | null>(null);
  const inFlight = useRef(false);
  const gone = useRef(false);

  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
    };
  }, []);

  const save = useCallback(
    async (request: KitSaveRequest) => {
      if (inFlight.current) return null;
      inFlight.current = true;
      setSaving(true);
      setFailure(null);
      setRefusal(null);
      try {
        return await send(request);
      } catch (problem) {
        if (!gone.current) {
          setFailure(kitSaveMessage(problem));
          setRefusal(kitSaveRefusal(problem));
        }
        return null;
      } finally {
        inFlight.current = false;
        if (!gone.current) setSaving(false);
      }
    },
    [send],
  );

  const clearFailure = useCallback(() => {
    setFailure(null);
    setRefusal(null);
  }, []);
  return { saving, failure, refusal, save, clearFailure };
}
