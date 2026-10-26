import { useId, useState } from "react";
import { Button, Field, Menu, MenuItem } from "../ui";
import { OverviewStrip } from "./OverviewStrip";
import { StatusRow } from "./StatusRow";
import { SystemIcon } from "./SystemIcon";

type SourceCardState =
  | "uploading"
  | "probing"
  | "ready"
  | "needs-name"
  | "failed"
  | "split-prompt";

const MIN_VOICES = 2;
const MAX_VOICES = 8;

export type SourceCardProps = {
  state: SourceCardState;
  /** 1-based position, so an unnamed voice reads "Hear voice 2". */
  index: number;
  name: string;
  onName: (name: string) => void;
  fileName: string;
  /** "5:11 of audio". Never a share. */
  audioTime?: string;
  /** 0 to 1 while uploading. */
  progress?: number;
  peaks?: readonly number[];
  playing?: boolean;
  onHear?: () => void;
  voices?: number;
  onVoices?: (voices: number) => void;
  onSplit?: () => void;
  onRemove: () => void;
  onReplace?: () => void;
  onMerge?: () => void;
  /** Plain cause when the file failed. */
  cause?: string;
  onRetry?: () => void;
  onDetails?: () => void;
  /** Another card carries this name too. */
  sameNameAs?: string;
};

function hasAudio(state: SourceCardState): boolean {
  return (
    state === "ready" || state === "needs-name" || state === "split-prompt"
  );
}

/**
 * One uploaded voice track. A section, not one big button: each control is
 * its own tab stop, in reading order.
 */
export function SourceCard({
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
  onSplit,
  onRemove,
  onReplace,
  onMerge,
  cause,
  onRetry,
  onDetails,
  sameNameAs,
}: SourceCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const stepperId = useId();
  const reasonId = useId();
  const named = name.trim();
  const who = named || `voice ${index}`;
  const atFewest = voices <= MIN_VOICES;
  const atMost = voices >= MAX_VOICES;
  const reason = atFewest
    ? "Two is the fewest"
    : atMost
      ? "Eight is the most"
      : null;
  return (
    <section
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
            autoComplete="off"
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
          progress={progress ?? 0}
          detail={`${Math.round((progress ?? 0) * 100)}%`}
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
          title="Sounds like more than one person"
          detail={audioTime}
        />
      ) : null}
      {state === "failed" ? (
        <StatusRow
          density="inline"
          state="failed"
          title={cause ?? "Could not read this file"}
          action={
            onRetry ? { label: "Try again", onAction: onRetry } : undefined
          }
        />
      ) : null}
      {hasAudio(state) ? (
        <>
          <div className="sys-source-wave" aria-hidden="true">
            <OverviewStrip height={16} peaks={peaks} label="Waveform" />
          </div>
          <div className="sys-source-controls">
            <Button
              className="ui-control--quiet sys-source-hear"
              aria-pressed={playing}
              onClick={onHear}
            >
              <SystemIcon name={playing ? "pause" : "play"} size={16} />
              {`Hear ${who}`}
            </Button>
            <div
              className="sys-stepper"
              role="group"
              aria-label="Number of voices"
              aria-describedby={reason ? reasonId : undefined}
            >
              <Button
                className="sys-stepper-button"
                aria-label="Fewer voices"
                aria-disabled={atFewest || undefined}
                onClick={atFewest ? undefined : () => onVoices?.(voices - 1)}
              >
                <SystemIcon name="minus" size={16} />
              </Button>
              <output
                id={stepperId}
                className="sys-stepper-value"
                aria-live="polite"
              >
                {voices}
              </output>
              <Button
                className="sys-stepper-button"
                aria-label="More voices"
                aria-disabled={atMost || undefined}
                onClick={atMost ? undefined : () => onVoices?.(voices + 1)}
              >
                <SystemIcon name="plus" size={16} />
              </Button>
            </div>
            {reason ? (
              <span id={reasonId} className="sys-stepper-reason">
                {reason}
              </span>
            ) : null}
            <Button
              variant={state === "split-prompt" ? "primary" : "default"}
              onClick={onSplit}
            >
              <SystemIcon name="split" size={14} />
              Split
            </Button>
          </div>
        </>
      ) : null}
      <div className="sys-source-actions">
        {state === "failed" && onDetails ? (
          <Button onClick={onDetails}>Details</Button>
        ) : null}
        <Button onClick={onRemove}>
          <SystemIcon name="trash-2" size={14} />
          Remove
        </Button>
        {hasAudio(state) ? (
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
              Replace audio...
            </MenuItem>
            <MenuItem
              onSelect={() => {
                setMenuOpen(false);
                onMerge?.();
              }}
            >
              Merge
            </MenuItem>
          </Menu>
        ) : null}
      </div>
    </section>
  );
}
