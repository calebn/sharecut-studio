import { useId, useRef, useState } from "react";
import { Button, Field, Menu, MenuItem } from "../ui";
import { OverviewStrip } from "./OverviewStrip";
import { percentOf } from "./progress";
import { StatusRow } from "./StatusRow";
import { SystemIcon } from "./SystemIcon";
import { useFocusRescue } from "./useFocusRescue";

type SourceCardState =
  | "uploading"
  | "probing"
  | "ready"
  | "new"
  | "needs-name"
  | "failed"
  | "split-prompt"
  | "splitting";

const MIN_VOICES = 2;
const MAX_VOICES = 8;
const MAX_NAME = 80;

export type SourceCardProps = {
  /** The track behind the card; lets the stage scroll to it. */
  sourceId?: string;
  state: SourceCardState;
  /** 1-based position, so an unnamed voice reads "Hear voice 2". */
  index: number;
  name: string;
  onName: (name: string) => void;
  fileName: string;
  /** "5:11 of audio". Never a share. */
  audioTime?: string;
  /** 0 to 1 while uploading or splitting (held to that range). */
  progress?: number;
  peaks?: readonly number[];
  playing?: boolean;
  onHear?: () => void;
  voices?: number;
  onVoices?: (voices: number) => void;
  /**
   * Show the voice count and Split. Defaults to the `split-prompt` state: one
   * recording that sounds like several people. Other cards are one voice.
   */
  canSplit?: boolean;
  onSplit?: () => void;
  /** Plain progress while `splitting`: "Finding voices · 1 of 1517". */
  splitDetail?: string;
  onCancelSplit?: () => void;
  onRemove: () => void;
  onReplace?: () => void;
  onMerge?: () => void;
  /** Reorder within the session without dragging. Omit at the ends. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  /** Plain cause when the file failed. */
  cause?: string;
  onRetry?: () => void;
  onDetails?: () => void;
  /** Another card in this session carries this name too: said aloud and shown. */
  sameNameAs?: string;
  /** A card in another session carries this name: only the control names differ. */
  nameElsewhere?: string;
};

function hasAudio(state: SourceCardState): boolean {
  return (
    state === "ready" ||
    state === "new" ||
    state === "needs-name" ||
    state === "split-prompt" ||
    state === "splitting"
  );
}

/** Visible words plus the card's name for assistive tech, so stacked cards differ. */
function Named({ label, who }: { label: string; who: string }) {
  return (
    <>
      {label} <span className="sr-only">{`for ${who}`}</span>
    </>
  );
}

/**
 * One uploaded voice track. A section, not one big button: each control is
 * its own tab stop, in reading order.
 */
export function SourceCard({
  sourceId,
  state,
  index,
  name,
  onName,
  fileName,
  audioTime,
  progress,
  peaks,
  playing = false,
  onHear,
  voices = MIN_VOICES,
  onVoices,
  canSplit,
  onSplit,
  splitDetail,
  onCancelSplit,
  onRemove,
  onReplace,
  onMerge,
  onMoveUp,
  onMoveDown,
  cause,
  onRetry,
  onDetails,
  sameNameAs,
  nameElsewhere,
}: SourceCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const card = useRef<HTMLElement>(null);
  useFocusRescue(card, () => () => card.current);
  const reasonId = useId();
  const named = name.trim();
  const who = !named
    ? `voice ${index}`
    : sameNameAs || nameElsewhere
      ? `${named}, voice ${index}`
      : named;
  const splittable = canSplit ?? state === "split-prompt";
  const atFewest = voices <= MIN_VOICES;
  const atMost = voices >= MAX_VOICES;
  const reason = atFewest
    ? "Two is the fewest"
    : atMost
      ? "Eight is the most"
      : null;
  return (
    <section
      ref={card}
      tabIndex={-1}
      data-source-id={sourceId}
      className="sys-source"
      aria-label={named ? `Voice ${index}, ${named}` : `Voice ${index}`}
      data-state={state}
    >
      <Field
        label="Speaker name"
        className="sys-source-name"
        hint={
          sameNameAs ? `Another voice is also called ${sameNameAs}.` : undefined
        }
      >
        {(control) => (
          <input
            {...control}
            type="text"
            aria-label={`Speaker name for voice ${index}`}
            autoComplete="off"
            maxLength={MAX_NAME}
            value={name}
            onChange={(event) => onName(event.target.value)}
          />
        )}
      </Field>
      <p className="sys-source-file">{fileName}</p>
      {state === "uploading" ? (
        <StatusRow
          density="inline"
          state="running"
          title="Uploading"
          barLabel={`Uploading ${fileName}`}
          progress={progress ?? 0}
          detail={`${percentOf(progress)}%`}
          valueText={`${percentOf(progress)} percent`}
        />
      ) : null}
      {state === "probing" ? (
        <StatusRow density="inline" state="running" title="Checking file" />
      ) : null}
      {state === "ready" ? (
        <StatusRow
          density="inline"
          state="done"
          title="Ready"
          detail={audioTime}
        />
      ) : null}
      {state === "new" ? (
        <StatusRow
          density="inline"
          state="queued"
          title="New"
          detail={
            audioTime ? `${audioTime} · not processed yet` : "Not processed yet"
          }
        />
      ) : null}
      {state === "needs-name" ? (
        <StatusRow
          density="inline"
          state="needs-you"
          title="Needs a name"
          detail={audioTime}
        />
      ) : null}
      {state === "split-prompt" ? (
        <StatusRow
          density="inline"
          state="needs-you"
          title="One recording of several people?"
          detail={audioTime}
        />
      ) : null}
      {state === "splitting" ? (
        <StatusRow
          density="inline"
          state="running"
          title="Finding voices"
          detail={splitDetail}
          progress={progress ?? 0}
          action={
            onCancelSplit
              ? {
                  label: "Cancel splitting",
                  name: `Cancel splitting ${who}`,
                  onAction: onCancelSplit,
                }
              : undefined
          }
        />
      ) : null}
      {state === "failed" ? (
        <StatusRow
          density="inline"
          state="failed"
          title={cause ?? "Could not read this file"}
          action={
            onRetry
              ? {
                  label: "Try again",
                  name: `Try again for ${who}`,
                  onAction: onRetry,
                }
              : undefined
          }
        />
      ) : null}
      {hasAudio(state) ? (
        <>
          <div className="sys-source-wave" aria-hidden="true">
            <OverviewStrip height={16} peaks={peaks} label="Waveform" />
          </div>
          {state === "splitting" ? null : (
            <div className="sys-source-controls">
              <Button
                className="ui-control--quiet sys-source-hear"
                aria-pressed={playing || undefined}
                onClick={onHear}
              >
                <SystemIcon name={playing ? "pause" : "play"} size={16} />
                {`Hear ${who}`}
              </Button>
              {splittable ? (
                <>
                  <div
                    className="sys-stepper"
                    role="group"
                    aria-label="Number of voices"
                    aria-describedby={reason ? reasonId : undefined}
                  >
                    <Button
                      className="sys-stepper-button"
                      aria-label={`Fewer voices for ${who}`}
                      aria-disabled={atFewest || undefined}
                      aria-describedby={atFewest ? reasonId : undefined}
                      onClick={
                        atFewest ? undefined : () => onVoices?.(voices - 1)
                      }
                    >
                      <SystemIcon name="minus" size={16} />
                    </Button>
                    <output className="sys-stepper-value" aria-live="polite">
                      {voices}
                    </output>
                    <Button
                      className="sys-stepper-button"
                      aria-label={`More voices for ${who}`}
                      aria-disabled={atMost || undefined}
                      aria-describedby={atMost ? reasonId : undefined}
                      onClick={
                        atMost ? undefined : () => onVoices?.(voices + 1)
                      }
                    >
                      <SystemIcon name="plus" size={16} />
                    </Button>
                  </div>
                  {reason ? (
                    <span id={reasonId} className="sys-stepper-reason">
                      {reason}
                    </span>
                  ) : null}
                  <Button onClick={onSplit} aria-label={`Split ${who}`}>
                    <SystemIcon name="split" size={14} />
                    Split
                  </Button>
                </>
              ) : null}
            </div>
          )}
        </>
      ) : null}
      <div className="sys-source-actions">
        {state === "failed" && onDetails ? (
          <Button onClick={onDetails} aria-label={`Details for ${who}`}>
            Details
          </Button>
        ) : null}
        <Button onClick={onRemove} aria-label={`Remove ${who}`}>
          <SystemIcon name="trash-2" size={14} />
          Remove
        </Button>
        {hasAudio(state) && state !== "splitting" ? (
          <Menu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            label={`More for ${who}`}
            className="ui-menu-root sys-menu"
            trigger={(props) => (
              <Button {...props} aria-label={`More for ${who}`}>
                <SystemIcon name="ellipsis" size={16} />
              </Button>
            )}
          >
            <MenuItem
              onSelect={() => {
                setMenuOpen(false);
                onReplace?.();
              }}
            >
              <Named label="Replace audio" who={who} />
            </MenuItem>
            {onMerge ? (
              <MenuItem
                onSelect={() => {
                  setMenuOpen(false);
                  onMerge();
                }}
              >
                <Named label="Merge" who={who} />
              </MenuItem>
            ) : null}
            {onMoveUp ? (
              <MenuItem
                onSelect={() => {
                  setMenuOpen(false);
                  onMoveUp();
                }}
              >
                <Named label="Move up" who={who} />
              </MenuItem>
            ) : null}
            {onMoveDown ? (
              <MenuItem
                onSelect={() => {
                  setMenuOpen(false);
                  onMoveDown();
                }}
              >
                <Named label="Move down" who={who} />
              </MenuItem>
            ) : null}
          </Menu>
        ) : null}
      </div>
    </section>
  );
}
