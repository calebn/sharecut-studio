import { type ReactNode, type RefObject, useRef, useState } from "react";
import { useLongPress } from "../hooks/useLongPress";
import type { ThemePreference } from "../hooks/useTheme";
import {
  Avatar,
  BrandSymbol,
  Menu,
  MenuItem,
  MenuSection,
  Pill,
  SegmentedControl,
  ToggleButton,
  useResizeObserver,
} from "../ui";
import type { SystemIconName } from "./icons";
import { SaveIndicator, type SaveIndicatorProps } from "./SaveIndicator";
import { StageBar, type StageBarProps } from "./StageBar";
import { StageMenu } from "./StageMenu";
import { SystemIcon } from "./SystemIcon";
import { VerbButton } from "./VerbButton";
import { capsOf, verbOf } from "./verbDisplay";

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
  guest?: { version: string; role: "Editor" | "Commenter" | "Viewer" };
  recent?: readonly string[];
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
  onRedo?: () => void;
  onInvite?: () => void;
  onPalette?: () => void;
  /** The title row in the Project menu was chosen: the host starts renaming in place (Fix text, F2). */
  onRename?: () => void;
  /** Undo was long-pressed or right-clicked: the host opens History. */
  onHistory?: () => void;
  onMenuCommand?: (command: string) => void;
};

const MAX_AVATARS = 3;

const APPEARANCE: readonly { id: ThemePreference; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

function Row({ icon, children }: { icon: SystemIconName; children: string }) {
  return (
    <>
      <SystemIcon name={icon} size={16} />
      {children}
    </>
  );
}

function ProjectMenu({
  title,
  recent = [],
  appearance,
  onCommand,
  onRename,
  onInvite,
  onPalette,
  people,
}: Pick<
  AppHeaderProps,
  "title" | "recent" | "appearance" | "onRename" | "onInvite" | "onPalette"
> & {
  people?: ReactNode;
  onCommand?: (command: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rename = verbOf("fixText");
  const run = (command: string) => () => {
    setOpen(false);
    onCommand?.(command);
  };
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      label="Project menu"
      className="ui-menu-root sys-menu sys-header-menu"
      trigger={(props) => (
        <button type="button" className="sys-header-project" {...props}>
          <BrandSymbol className="sys-header-symbol" />
          <span className="sys-header-title">{title}</span>
        </button>
      )}
    >
      {/*
        The title as a field-looking row (design system 2, Menu). A real text
        input cannot sit in role="menu" (axe: aria-required-children, and a
        menu item's children are presentational), so choosing the row starts
        the in-place rename instead.
      */}
      {onRename ? (
        <MenuItem
          shortcut={capsOf(rename.keys[0]).join(" ")}
          onSelect={() => {
            setOpen(false);
            onRename();
          }}
        >
          <span className="sys-menu-field">
            <SystemIcon name="text-cursor-input" size={16} />
            <span className="sr-only">Rename project, </span>
            <span className="sys-menu-field-text">{title}</span>
          </span>
        </MenuItem>
      ) : null}
      {recent.length > 0 ? (
        <MenuSection label="Recent">
          {recent.slice(0, 5).map((name) => (
            <MenuItem key={name} onSelect={run(`open:${name}`)}>
              <Row icon="history">{name}</Row>
            </MenuItem>
          ))}
        </MenuSection>
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
      <MenuItem onSelect={run("settings")}>
        <Row icon="settings">Settings</Row>
      </MenuItem>
      <MenuItem onSelect={run("agent")}>
        <Row icon="plug">Connect agent</Row>
      </MenuItem>
      <MenuItem onSelect={run("help")}>
        <Row icon="circle-help">Help</Row>
      </MenuItem>
      {appearance ? (
        <MenuSection label="Appearance">
          {/* Radios keep the menu open so the themes can be compared in place. */}
          <SegmentedControl role="none">
            {APPEARANCE.map((option) => (
              <ToggleButton
                key={option.id}
                quiet
                role="menuitemradio"
                tabIndex={-1}
                pressed={appearance.value === option.id}
                aria-checked={appearance.value === option.id}
                onClick={() => appearance.onChange(option.id)}
              >
                {option.label}
              </ToggleButton>
            ))}
          </SegmentedControl>
        </MenuSection>
      ) : null}
    </Menu>
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
  recent,
  appearance,
  loading = false,
  canUndo = true,
  canRedo = true,
  onUndo,
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
  const canEdit = !guest || guest.role === "Editor";
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
                <span className="sys-mono">{guest.version}</span>
                <Pill>{guest.role}</Pill>
              </span>
            </div>
          ) : (
            <ProjectMenu
              title={title}
              recent={recent}
              appearance={appearance}
              onCommand={onMenuCommand}
              onRename={onRename}
              onInvite={canInvite ? onInvite : undefined}
              onPalette={onPalette}
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
                <VerbButton
                  verb="undo"
                  disabled={loading || !canUndo}
                  onClick={onUndo}
                />
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
              <VerbButton verb="palette" onClick={onPalette} />
            </>
          )}
        </div>
      </div>
    </header>
  );
}
