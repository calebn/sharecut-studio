import { useEffect, useRef } from "react";
import type { ThemePreference } from "../hooks/useTheme";
import { AppearanceControl } from "../system/AppearanceControl";
import type { SystemIconName } from "../system/icons";
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

export type SettingsSheetProps = {
  open: boolean;
  onClose: () => void;
  phone: boolean;
  theme: ThemePreference;
  onTheme: (preference: ThemePreference) => void;
  /** Inside a project only. */
  savedIn?: SettingsSavedIn;
  onOpenModels: () => void;
  /** Inside a project only. */
  onOpenShortcuts?: () => void;
};

const KEEP_START = 14;
const KEEP_END = 24;

/** A long folder keeps its start and its last folders; the full path stays in `title`. */
function middleTruncate(path: string): string {
  return path.length <= KEEP_START + KEEP_END + 1
    ? path
    : `${path.slice(0, KEEP_START)}…${path.slice(-KEEP_END)}`;
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
 * Settings from the app menu: Appearance, where the project is saved, and the
 * way into Models and Keyboard shortcuts. A side sheet on desktop and tablet,
 * a bottom sheet as tall as its rows on the phone. Rows act as they change.
 */
export function SettingsSheet({
  open,
  onClose,
  phone,
  theme,
  onTheme,
  savedIn,
  onOpenModels,
  onOpenShortcuts,
}: SettingsSheetProps) {
  const revealRef = useRef<HTMLButtonElement>(null);
  const moveRef = useRef<HTMLButtonElement>(null);
  const wasRevealing = useRef(false);
  const wasMoving = useRef(false);
  const revealing = savedIn?.revealing ?? false;
  const moving = savedIn?.moving ?? false;
  // A disabled button drops focus; give it back when the request ends, so a
  // failure leaves the person on the button that caused it.
  useEffect(() => {
    const was = wasRevealing.current;
    wasRevealing.current = revealing;
    if (!was || revealing) return;
    const active = document.activeElement;
    if (!active || active === document.body) revealRef.current?.focus();
  }, [revealing]);
  useEffect(() => {
    const was = wasMoving.current;
    wasMoving.current = moving;
    if (!was || moving) return;
    const active = document.activeElement;
    if (!active || active === document.body) moveRef.current?.focus();
  }, [moving]);
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
              {savedIn.onReveal ? (
                <Button
                  ref={revealRef}
                  type="button"
                  disabledReason={
                    savedIn.revealing || moving ? BUSY_REASON : undefined
                  }
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
                  disabledReason={
                    moving || savedIn.revealing ? BUSY_REASON : undefined
                  }
                  aria-busy={moving || undefined}
                  onClick={savedIn.onMove}
                >
                  {moving ? "Moving…" : "Move…"}
                </Button>
              ) : null}
            </div>
            <InlineError message={savedIn.error} />
          </section>
        ) : null}
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
