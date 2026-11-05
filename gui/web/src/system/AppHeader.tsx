import { type ReactNode, type RefObject, useId, useRef, useState } from "react";
import { useLongPress } from "../hooks/useLongPress";
import type { ThemePreference } from "../hooks/useTheme";
import {
  Avatar,
  BrandSymbol,
  Dialog,
  Menu,
  MenuItem,
  MenuSection,
  useOutsidePointerDown,
  useResizeObserver,
} from "../ui";
import { AppearanceControl } from "./AppearanceControl";
import { AppMenuItems } from "./AppMenuItems";
import { type CoachHint, CoachTip } from "./CoachTip";
import type { SystemIconName } from "./icons";
import { type LinkRole, ROLES } from "./linkRoles";
import { RenameProjectPopover } from "./RenameProjectPopover";
import { RoleChip } from "./RoleChip";
import { SaveIndicator, type SaveIndicatorProps } from "./SaveIndicator";
import { StageBar, type StageBarProps } from "./StageBar";
import { StageMenu } from "./StageMenu";
import { SystemIcon } from "./SystemIcon";
import { VerbButton } from "./VerbButton";
import { type NewVersionUpdate, VersionLine } from "./VersionLine";

export type HeaderPerson = { name: string; colorIndex?: number };

export type AppHeaderProps = {
  title: string;
  /** Omitted when there is nothing to say yet, or for a guest: no light is better than a wrong one. */
  save?: SaveIndicatorProps;
  /** Omitted when the header has no Stage bar (Record guests). */
  stages?: StageBarProps;
  people?: readonly HeaderPerson[];
  /** The app's own people control (Follow, Go to). Replaces the static list. */
  peopleSlot?: ReactNode;
  /** The People rows (Follow) in the Project menu, for a window too short for the header's right side. */
  menuPeople?: ReactNode;
  /** A short window folds the tab bar and the Edit tools into the header: the Tools button goes here. */
  toolsSlot?: ReactNode;
  /** The window is short: the Stage menu and the Tools slot show, because the tab bar and the Edit rows are folded in. */
  compact?: boolean;
  /**
   * The Stage bar is not in the header while it is compact (the phone: the tab
   * bar is folded in), so the Stage menu lists the stages. Off the phone the bar
   * stays, and the menu holds only what the right side held. Default true.
   */
  stagesInMenu?: boolean;
  /** A guest: the title gets a second line with the version and a Role chip. */
  guest?: {
    version: string;
    /** True: the link plays whatever version is current. False: pinned. Omitted: not known yet. */
    followsLatest?: boolean;
    /** A following link's host published: shows the New version pill. */
    update?: NewVersionUpdate;
    role: LinkRole;
    compact?: boolean;
    hint?: { text: string; shown: boolean; onDismiss: () => void };
  };
  /** Theme row at the bottom of the Project menu. */
  appearance?: {
    value: ThemePreference;
    onChange: (value: ThemePreference) => void;
  };
  /** The project is still loading: the title is known, the rest waits. */
  loading?: boolean;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  undoHint?: CoachHint;
  onRedo?: () => void;
  onInvite?: () => void;
  onPalette?: () => void;
  /**
   * "Rename project" in the Project menu opens a card with the name; Enter
   * applies the trimmed name. A rejection keeps the card open with its reason.
   * Left out (a guest, or a project that cannot be renamed), the row is absent.
   */
  onRename?: (name: string) => void | Promise<void>;
  /** Undo was long-pressed or right-clicked: the host opens History. */
  onHistory?: () => void;
  onMenuCommand?: (command: string) => void;
};

const MAX_AVATARS = 3;

type RoleHintMode = "automatic" | "closed" | "manual";

function RoleHint({ guest }: { guest: NonNullable<AppHeaderProps["guest"]> }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const outsideRef = useRef<HTMLSpanElement>(null);
  const panelId = useId();
  const eligible = guest.hint?.shown ?? false;
  const [mode, setMode] = useState<RoleHintMode>(() =>
    eligible ? "automatic" : "closed",
  );
  if (!eligible && mode === "automatic") setMode("closed");
  const label =
    ROLES.find((role) => role.id === guest.role)?.label ?? guest.role;

  const dismissAutomatic = () => {
    if (mode !== "automatic") return;
    setMode("closed");
    guest.hint?.onDismiss();
  };
  const dismissAutomaticFromTip = () => {
    dismissAutomatic();
    triggerRef.current?.focus({ preventScroll: true });
  };
  useOutsidePointerDown({
    liveRefs: [outsideRef],
    onOutside: dismissAutomatic,
    enabled: mode === "automatic",
    capture: true,
  });

  const chip = <RoleChip access={guest.role} compact={guest.compact} />;
  if (!guest.hint) return chip;

  return (
    <>
      <span ref={outsideRef}>
        <CoachTip
          edge
          text={guest.hint.text}
          shown={mode === "automatic"}
          onDismiss={dismissAutomaticFromTip}
        >
          <span aria-hidden="true" />
        </CoachTip>
        <button
          ref={triggerRef}
          type="button"
          className="sys-icon-btn"
          aria-label={`Explain ${label} role`}
          aria-haspopup="dialog"
          aria-expanded={mode === "manual"}
          aria-controls={mode === "manual" ? panelId : undefined}
          onClick={() => {
            if (mode === "automatic") {
              dismissAutomatic();
            } else if (mode === "manual") {
              setMode("closed");
            } else {
              triggerRef.current?.focus({ preventScroll: true });
              setMode("manual");
            }
          }}
        >
          {chip}
        </button>
      </span>
      <Dialog
        outsideDismissal="preserve-focus"
        open={mode === "manual"}
        onClose={() => setMode("closed")}
        title={`${label} role`}
        panelId={panelId}
        anchor={{
          reason: "The guest role explanation stays beside its header control.",
          ref: triggerRef,
        }}
      >
        {guest.hint.text}
      </Dialog>
    </>
  );
}

function Row({ icon, children }: { icon: SystemIconName; children: string }) {
  return (
    <>
      <SystemIcon name={icon} size={16} />
      {children}
    </>
  );
}

function AppearanceSection({
  value,
  onChange,
}: NonNullable<AppHeaderProps["appearance"]>) {
  return (
    <MenuSection label="Appearance">
      {/* Radios keep the menu open so the themes can be compared in place. */}
      <AppearanceControl value={value} onChange={onChange} variant="menu" />
    </MenuSection>
  );
}

/** A link has no Project menu, so its theme choice lives in a menu of its own. */
function GuestAppearanceMenu(
  appearance: NonNullable<AppHeaderProps["appearance"]>,
) {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      label="Appearance"
      className="ui-menu-root sys-menu"
      trigger={(props) => (
        <button
          type="button"
          className="sys-icon-btn"
          aria-label="Appearance"
          title="Appearance"
          {...props}
        >
          <SystemIcon name="sun-moon" size={16} />
        </button>
      )}
    >
      <AppearanceSection {...appearance} />
    </Menu>
  );
}

function ProjectMenu({
  title,
  appearance,
  onCommand,
  onInvite,
  onPalette,
  onRename,
  people,
}: Pick<
  AppHeaderProps,
  "title" | "appearance" | "onInvite" | "onPalette" | "onRename"
> & {
  people?: ReactNode;
  onCommand?: (command: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const projectButton = useRef<HTMLButtonElement | null>(null);
  const run = (command: string) => () => {
    setOpen(false);
    onCommand?.(command);
  };
  return (
    <>
      <Menu
        open={open}
        onOpenChange={setOpen}
        label="Project menu"
        className="ui-menu-root sys-menu sys-header-menu"
        trigger={({ ref, ...props }) => (
          <button
            type="button"
            className="sys-header-project"
            data-app-menu
            {...props}
            ref={(node) => {
              ref(node);
              projectButton.current = node;
            }}
          >
            <BrandSymbol className="sys-header-symbol" />
            <span className="sys-header-title">{title}</span>
          </button>
        )}
      >
        {onRename ? (
          <MenuItem
            onSelect={() => {
              setOpen(false);
              setRenaming(true);
            }}
          >
            <Row icon="text-cursor-input">Rename project</Row>
          </MenuItem>
        ) : null}
        <MenuItem onSelect={run("projects")}>
          <Row icon="folder-open">All projects</Row>
        </MenuItem>
        {/* In a window too short for the header's right side, these stay reachable. */}
        {onInvite ? (
          <MenuItem
            onSelect={() => {
              setOpen(false);
              onInvite();
            }}
          >
            <Row icon="user-plus">Invite</Row>
          </MenuItem>
        ) : null}
        {onPalette ? (
          <MenuItem
            onSelect={() => {
              setOpen(false);
              onPalette();
            }}
          >
            <Row icon="search">Search commands and people</Row>
          </MenuItem>
        ) : null}
        {people}
        <AppMenuItems onSelect={(row) => run(row)()} />
        {appearance ? <AppearanceSection {...appearance} /> : null}
      </Menu>
      {onRename ? (
        <RenameProjectPopover
          open={renaming}
          name={title}
          anchorRef={projectButton}
          onRename={onRename}
          onClose={() => setRenaming(false)}
        />
      ) : null}
    </>
  );
}

/** The header width (rem) at and under which its right side gives way (system.css). */
const RIGHT_SIDE_MIN_REM = 20;

/**
 * Whether the header is too narrow for its right side. The side is not
 * rendered then, so a control the layout hides is not left in the tree.
 */
function useNarrowHeader(host: RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);
  useResizeObserver(host, (entries) => {
    const width = entries.at(-1)?.contentRect.width ?? 0;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    setNarrow(width > 0 && width <= RIGHT_SIDE_MIN_REM * rem);
  });
  return narrow;
}

/**
 * The 48 px App header (44 on phone, by container width). Left: Project menu,
 * Save indicator, Undo and Redo. Center: the Stage bar. Right: people, Invite,
 * Palette. Below 40rem (the phone) the Stage bar hides, because the phone has
 * the tab bar, people shrink to one avatar and a count, and the Save indicator
 * shrinks to its glyph.
 */
export function AppHeader({
  title,
  save,
  stages,
  people = [],
  peopleSlot,
  menuPeople,
  toolsSlot,
  compact = false,
  stagesInMenu = true,
  guest,
  appearance,
  loading = false,
  canUndo = true,
  canRedo = true,
  onUndo,
  undoHint,
  onRedo,
  onInvite,
  onPalette,
  onRename,
  onHistory,
  onMenuCommand,
}: AppHeaderProps) {
  const historyPress = useLongPress(() => onHistory?.());
  const shown = people.slice(0, MAX_AVATARS);
  const extra = people.length - shown.length;
  const canEdit = !guest || guest.role === "editor";
  // Inviting is the host's: a link of any role cannot share the project.
  const canInvite = !guest;
  const host = useRef<HTMLElement>(null);
  const rightGivesWay = useNarrowHeader(host) || compact;
  // What the right side holds moves into the Stage menu while it gives way, so
  // a link with no Project menu (a Viewer or Commenter) keeps Follow and search.
  const extras = rightGivesWay ? (
    <>
      {menuPeople}
      {onPalette ? (
        <MenuItem onSelect={() => onPalette()}>
          <Row icon="search">Search commands and people</Row>
        </MenuItem>
      ) : null}
      {canInvite && onInvite ? (
        <MenuItem onSelect={() => onInvite()}>
          <Row icon="user-plus">Invite</Row>
        </MenuItem>
      ) : null}
      {guest && appearance ? <AppearanceSection {...appearance} /> : null}
    </>
  ) : undefined;
  return (
    <header
      ref={host}
      className="sys-app-header-host"
      aria-busy={loading || undefined}
    >
      <h1 className="sr-only">{title}</h1>
      <div className="sys-app-header">
        <div className="sys-header-left">
          {guest ? (
            <div className="sys-header-guest">
              <span className="sys-header-title" aria-hidden="true">
                {title}
              </span>
              <span className="sys-header-sub">
                <VersionLine
                  label={guest.version}
                  followsLatest={guest.followsLatest}
                  update={guest.update}
                />
                <RoleHint key={guest.role} guest={guest} />
              </span>
            </div>
          ) : (
            <ProjectMenu
              title={title}
              appearance={appearance}
              onCommand={onMenuCommand}
              onInvite={canInvite ? onInvite : undefined}
              onPalette={onPalette}
              onRename={onRename}
              people={menuPeople}
            />
          )}
          {loading || !save ? null : <SaveIndicator {...save} />}
          {canEdit ? (
            <>
              {/* Long-press and right-click on Undo or Redo open History; a plain press stays Undo or Redo. */}
              <span
                className="sys-header-history"
                onContextMenu={
                  onHistory
                    ? (event) => {
                        event.preventDefault();
                        onHistory();
                      }
                    : undefined
                }
                {...(onHistory ? historyPress : {})}
              >
                <CoachTip
                  edge
                  align="end"
                  placement="below"
                  text={undoHint?.text ?? ""}
                  shown={undoHint?.shown ?? false}
                  onDismiss={undoHint?.onDismiss}
                >
                  <VerbButton
                    verb="undo"
                    disabled={loading || !canUndo}
                    onClick={onUndo}
                  />
                </CoachTip>
                <VerbButton
                  verb="redo"
                  disabled={loading || !canRedo}
                  onClick={onRedo}
                />
              </span>
            </>
          ) : null}
          {rightGivesWay ? (
            <div className="sys-header-short">
              <StageMenu
                {...(compact && stagesInMenu ? stages : undefined)}
                extras={extras}
              />
              {toolsSlot}
            </div>
          ) : null}
        </div>
        {stages ? (
          <div className="sys-header-stages">
            <StageBar {...stages} />
          </div>
        ) : null}
        <div className="sys-header-right">
          {rightGivesWay ? null : (
            <>
              {peopleSlot ? (
                <div className="sys-header-people-slot">{peopleSlot}</div>
              ) : shown.length > 0 ? (
                <ul className="sys-header-people" aria-label="People here">
                  {shown.map((person) => (
                    <li key={person.name}>
                      <Avatar
                        name={person.name}
                        colorIndex={person.colorIndex}
                        size="sm"
                      />
                    </li>
                  ))}
                  {extra > 0 ? (
                    <li className="sys-header-more">
                      <span aria-hidden="true">+{extra}</span>
                      <span className="sr-only">{extra} more</span>
                    </li>
                  ) : null}
                  {people.length > 1 ? (
                    <li className="sys-header-phone-count">
                      <span aria-hidden="true">+{people.length - 1}</span>
                      <span className="sr-only">{people.length - 1} more</span>
                    </li>
                  ) : null}
                </ul>
              ) : null}
              {canInvite ? (
                <VerbButton verb="invite" onClick={onInvite} />
              ) : null}
              {guest && appearance ? (
                <GuestAppearanceMenu {...appearance} />
              ) : null}
              <VerbButton verb="palette" onClick={onPalette} />
            </>
          )}
        </div>
      </div>
    </header>
  );
}
