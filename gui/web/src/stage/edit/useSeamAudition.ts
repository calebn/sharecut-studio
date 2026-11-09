import { useCallback, useEffect, useRef, useState } from "react";
import {
  auditionBoundary,
  fetchBoundaryAudio,
  loadBoundaryContext,
} from "../../api";
import { seamGeometry } from "../../commands/seamCommands";
import type { Seam } from "../../edit/seam";
import { useDawStore } from "../../state/dawStore";
import type { AuditionSide } from "../../system/auditionWindow";
import { errorMessage } from "../../utils/apiError";

export type SeamAbAudio = {
  key: string;
  before: string;
  after: string;
  beforeSec: number;
  afterSec: number;
};

export const AB_CLAMPED_REASON = "The seam can't return to where it was";
export const AB_PREPARING_NOTE = "Preparing the comparison…";

const PAD_SEC = 1.5;
const SAME_SEC = 1e-9;
const RETURN_TOLERANCE_SEC = 1e-6;

class ClampedReturn extends Error {}

function geometryKey({ left, right }: Seam): string {
  return `${left.id}:${left.source_end}:${right.id}:${right.source_start}:${right.timeline_start}`;
}

/**
 * Hears a rolled seam against where it was when its sheet opened. A is the
 * rendered track window with the roll undone, B the window as it is now. The
 * server's URLs die with the next edit to the track, so both windows are
 * fetched into blobs the moment the audition returns.
 */
export function useSeamAudition(seam: Seam | null, originEnd: number | null) {
  const [side, setSide] = useState<AuditionSide>("B");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const held = useRef<SeamAbAudio | null>(null);
  const request = useRef<AbortController | null>(null);
  const wanted = useRef<AuditionSide>("B");
  const key = seam ? geometryKey(seam) : null;
  const owner = seam ? `seam-ab:${seam.id}` : null;

  useEffect(() => {
    setSide("B");
    setPending(false);
    setFailure(null);
    return () => {
      request.current?.abort();
      request.current = null;
      const stale = held.current;
      held.current = null;
      if (stale) {
        URL.revokeObjectURL(stale.before);
        URL.revokeObjectURL(stale.after);
      }
      if (key && owner) useDawStore.getState().releaseSourcePreview(owner);
    };
  }, [key, owner]);

  const play = useCallback(
    (next: AuditionSide) => {
      if (!seam || !key || !owner || originEnd === null) return;
      const reverseSec = originEnd - seam.left.source_end;
      if (Math.abs(reverseSec) <= SAME_SEC) return;
      wanted.current = next;
      setSide(next);
      const begin = (audio: SeamAbAudio) => {
        const before = wanted.current === "A";
        useDawStore.getState().beginSourcePreview({
          ownerId: owner,
          media: {
            kind: "rendered",
            url: before ? audio.before : audio.after,
          },
          startSec: 0,
          endSec: before ? audio.beforeSec : audio.afterSec,
        });
      };
      if (held.current?.key === key) {
        begin(held.current);
        return;
      }
      if (request.current) return;
      const controller = new AbortController();
      request.current = controller;
      setPending(true);
      setFailure(null);
      const { projectPath, projectEpoch } = useDawStore.getState();
      const target = {
        kind: "roll",
        left_clip_id: seam.left.id,
        right_clip_id: seam.right.id,
      } as const;
      void (async () => {
        try {
          const context = await loadBoundaryContext(
            projectPath,
            target,
            seamGeometry(seam),
            controller.signal,
            "The server didn't answer. Try again.",
          );
          const audition = await auditionBoundary(
            projectPath,
            target,
            { ...target, delta_sec: reverseSec },
            context.token,
            controller.signal,
            PAD_SEC,
          );
          const actual = audition.actual_edit;
          if (
            actual.kind !== "roll" ||
            Math.abs(actual.delta_sec - reverseSec) > RETURN_TOLERANCE_SEC
          )
            throw new ClampedReturn();
          const [before, after] = await Promise.all([
            fetchBoundaryAudio(
              audition.proposed.url,
              audition.token,
              controller.signal,
            ),
            fetchBoundaryAudio(
              audition.current.url,
              audition.token,
              controller.signal,
            ),
          ]);
          const live = useDawStore.getState();
          if (
            controller.signal.aborted ||
            live.projectPath !== projectPath ||
            live.projectEpoch !== projectEpoch
          )
            return;
          held.current = {
            key,
            before: URL.createObjectURL(before),
            after: URL.createObjectURL(after),
            beforeSec: audition.proposed.duration_sec,
            afterSec: audition.current.duration_sec,
          };
          begin(held.current);
        } catch (thrown) {
          if (controller.signal.aborted) return;
          setFailure(
            thrown instanceof ClampedReturn
              ? AB_CLAMPED_REASON
              : errorMessage(thrown),
          );
        } finally {
          if (request.current === controller) {
            request.current = null;
            setPending(false);
          }
        }
      })();
    },
    [seam, key, owner, originEnd],
  );

  return { side, pending, error: failure, play };
}
