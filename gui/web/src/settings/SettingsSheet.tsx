import { type RefObject, useEffect, useId, useRef } from "react";
import type { ThemePreference } from "../hooks/useTheme";
import { AppearanceControl } from "../system/AppearanceControl";
import type { SystemIconName } from "../system/icons";
import { ScrubField } from "../system/ScrubField";
import { Sheet } from "../system/Sheet";
import { SystemIcon } from "../system/SystemIcon";
import { Button, InlineError } from "../ui";
import { BUSY_REASON } from "../ui/disabledReason";

export type SettingsSavedIn = {
  folder: string;
  /** Left out where the file manager cannot be opened (the browser). */
  onReveal?: () => void;
  revealing: boolean;
  /** Left out with `onReveal`: the host's folder dialog is a desktop-app feature too. */
  onMove?: () => void;
  moving?: boolean;
  error: string | null;
};

const JOIN_FADE_LIMIT_MAX_MS = 200;
const JOIN_FADE_LIMIT_STEP_MS = 5;
const JOIN_FADE_LIMIT_LABEL = "Longest automatic join fade";
const JOIN_FADE_LIMIT_HELP =
  "ShareCut picks each automatic join fade up to this length. Fades you set yourself are not limited.";

export type SettingsJoinFadeLimit = {
  /** Null until the episode's clips have loaded. */
  valueMs: number | null;
  /** The app default the reset dot returns to; unknown until the episode's clips have loaded. */
  defaultMs?: number;
  /** Left out where the person may not edit the episode, with the reason in `readOnlyReason`. */
  onCommit?: (ms: number) => void;
  readOnlyReason?: string;
  saving: boolean;
  error: string | null;
};

export type SettingsSheetProps = {
  open: boolean;
  onClose: () => void;
  phone: boolean;
  theme: ThemePreference;
  onTheme: (preference: ThemePreference) => void;
  /** Inside a project only. */
  savedIn?: SettingsSavedIn;
  /** Inside a project only. */
  joinFadeLimit?: SettingsJoinFadeLimit;
  onOpenModels: () => void;
  /** Inside a project only. */
  onOpenShortcuts?: () => void;
};

/**
 * A disabled button drops focus (to the page, or to the sheet's close button);
 * give it back when the request ends, so a failure leaves the person on the
 * button that caused it.
 */
function useRestoreFocus(
  working: boolean,
  button: RefObject<HTMLButtonElement | null>,
) {
  const was = useRef(false);
  useEffect(() => {
    const wasWorking = was.current;
    was.current = working;
    if (!wasWorking || working) return;
    const active = document.activeElement;
    if (
      !active ||
      active === document.body ||
      active.closest(".dialog-close")
    ) {
      button.current?.focus();
    }
  }, [working, button]);
}

const KEEP_START = 14;
const KEEP_END = 24;

/** A long folder keeps its start and its last folders; the full path stays in `title`. */
function middleTruncate(path: string): string {
  return path.length <= KEEP_START + KEEP_END + 1
    ? path
    : `${path.slice(0, KEEP_START)}…${path.slice(-KEEP_END)}`;
}

function JoinFadeLimitRow({
  valueMs,
  defaultMs,
  onCommit,
  readOnlyReason,
  saving,
  error,
}: SettingsJoinFadeLimit) {
  const helpId = useId();
  const reasonId = useId();
  return (
    <section
      className="settings-sheet-section"
      aria-label={JOIN_FADE_LIMIT_LABEL}
    >
      <h3 className="settings-sheet-label">{JOIN_FADE_LIMIT_LABEL}</h3>
      <ScrubField
        label={JOIN_FADE_LIMIT_LABEL}
        value={valueMs}
        emptyText="Loading…"
        unit="ms"
        min={0}
        max={JOIN_FADE_LIMIT_MAX_MS}
        step={JOIN_FADE_LIMIT_STEP_MS}
        decimals={0}
        integerOnly
        defaultValue={defaultMs}
        skipUnchanged
        readOnly={!onCommit || saving || valueMs === null}
        describedBy={readOnlyReason ? `${helpId} ${reasonId}` : helpId}
        onCommit={(ms) => onCommit?.(ms)}
      />
      <p id={helpId} className="settings-sheet-help">
        {JOIN_FADE_LIMIT_HELP}
      </p>
      {readOnlyReason ? (
        <p id={reasonId} className="settings-sheet-help">
          {readOnlyReason}
        </p>
      ) : null}
      <InlineError message={error} />
    </section>
  );
}

function NavRow({
  icon,
  label,
  onSelect,
}: {
  icon: SystemIconName;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button type="button" className="settings-sheet-nav" onClick={onSelect}>
      <span className="settings-sheet-nav-label">
        <SystemIcon name={icon} size={16} />
        {label}
      </span>
      <SystemIcon name="chevron-right" size={16} />
    </button>
  );
}

/**
 * Settings from the app menu: Appearance, where the project is saved, the
 * episode's Longest automatic join fade, and the way into Models and Keyboard
 * shortcuts. A side sheet on desktop and tablet, a bottom sheet as tall as its
 * rows on the phone. Rows act as they change.
 */
export function SettingsSheet({
  open,
  onClose,
  phone,
  theme,
  onTheme,
  savedIn,
  joinFadeLimit,
  onOpenModels,
  onOpenShortcuts,
}: SettingsSheetProps) {
  const revealRef = useRef<HTMLButtonElement>(null);
  const moveRef = useRef<HTMLButtonElement>(null);
  const revealing = savedIn?.revealing ?? false;
  const moving = savedIn?.moving ?? false;
  const busy = revealing || moving;
  useRestoreFocus(revealing, revealRef);
  useRestoreFocus(moving, moveRef);
  return (
    <Sheet
      form={phone ? "bottom" : "end"}
      open={open}
      onClose={onClose}
      title="Settings"
      detent="fit"
      panelClassName="settings-sheet"
    >
      <div className="settings-sheet-body">
        <section className="settings-sheet-section" aria-label="Appearance">
          <h3 className="settings-sheet-label">Appearance</h3>
          <AppearanceControl value={theme} onChange={onTheme} variant="radio" />
        </section>
        {savedIn ? (
          <section className="settings-sheet-section" aria-label="Saved in">
            <h3 className="settings-sheet-label">Saved in</h3>
            <div className="settings-sheet-saved">
              <span className="settings-sheet-path" title={savedIn.folder}>
                {middleTruncate(savedIn.folder)}
              </span>
              {savedIn.onReveal || savedIn.onMove ? (
                <div className="settings-sheet-actions">
                  {savedIn.onReveal ? (
                    <Button
                      ref={revealRef}
                      type="button"
                      disabledReason={busy ? BUSY_REASON : undefined}
                      aria-busy={savedIn.revealing || undefined}
                      onClick={savedIn.onReveal}
                    >
                      {savedIn.revealing ? "Revealing…" : "Reveal in folder"}
                    </Button>
                  ) : null}
                  {savedIn.onMove ? (
                    <Button
                      ref={moveRef}
                      type="button"
                      disabledReason={busy ? BUSY_REASON : undefined}
                      aria-busy={moving || undefined}
                      onClick={savedIn.onMove}
                    >
                      {moving ? "Moving…" : "Move…"}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
            <InlineError message={savedIn.error} />
          </section>
        ) : null}
        {joinFadeLimit ? <JoinFadeLimitRow {...joinFadeLimit} /> : null}
        <div className="settings-sheet-nav-list">
          <NavRow
            icon="cloud-download"
            label="Models"
            onSelect={onOpenModels}
          />
          {onOpenShortcuts ? (
            <NavRow
              icon="keyboard"
              label="Keyboard shortcuts"
              onSelect={onOpenShortcuts}
            />
          ) : null}
        </div>
      </div>
    </Sheet>
  );
}
