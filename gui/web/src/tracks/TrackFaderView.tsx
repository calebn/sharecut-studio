import { type ReactNode, useState } from "react";
import { ScrubField } from "../system/ScrubField";
import {
  FADER_MAX_DB,
  FADER_MIN_DB,
  FADER_STEP_DB,
  trackOutputGainDb,
} from "../utils/audio";

export type FaderAccess =
  | { kind: "edit"; onCommit: (db: number) => void }
  | { kind: "read-only"; onCommit?: never };

export type FaderPresentation = {
  kind: "compact";
  stagingDb?: number;
  playsAt?: (baseDb: number) => ReactNode;
};

export type TrackFaderViewProps = {
  trackLabel: string;
  savedDb: number;
  access: FaderAccess;
  presentation: FaderPresentation;
  /** The id of the note that says why the fader is read-only. */
  noteId?: string;
};

/** A track's saved volume as a level Scrub field: drag previews, release saves one undo step. */
export function TrackFaderView({
  trackLabel,
  savedDb,
  access,
  presentation,
  noteId,
}: TrackFaderViewProps) {
  const [draftDb, setDraftDb] = useState<number | null>(null);
  const { playsAt, stagingDb } = presentation;
  return (
    <div className="track-fader track-fader--compact">
      <ScrubField
        variant="level"
        label={`Volume ${trackLabel}`}
        unit="dB"
        min={FADER_MIN_DB}
        max={FADER_MAX_DB}
        step={FADER_STEP_DB}
        defaultValue={0}
        value={draftDb ?? savedDb}
        skipUnchanged
        readOnly={access.kind !== "edit"}
        describedBy={access.kind !== "edit" ? noteId : undefined}
        onPreview={setDraftDb}
        onCancel={() => setDraftDb(null)}
        onCommit={(db) => {
          setDraftDb(null);
          if (access.kind === "edit") access.onCommit(db);
        }}
      />
      {playsAt?.(
        trackOutputGainDb({
          gain_db: stagingDb ?? 0,
          fader_db: draftDb ?? savedDb,
        }),
      )}
    </div>
  );
}
