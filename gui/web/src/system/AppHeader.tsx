import { useState } from "react";
import { Avatar, BrandSymbol, Menu, MenuItem, MenuSection, Pill } from "../ui";
import { SaveIndicator, type SaveIndicatorProps } from "./SaveIndicator";
import { StageBar, type StageBarProps } from "./StageBar";
import { VerbButton } from "./VerbButton";
import { capsOf, verbOf } from "./verbDisplay";

export type HeaderPerson = { name: string; colorIndex?: number };

export type AppHeaderProps = {
  title: string;
  save: SaveIndicatorProps;
  /** Omitted when the header has no Stage bar (Record guests). */
  stages?: StageBarProps;
  people?: readonly HeaderPerson[];
  /** A guest: the title gets a second line with the version and a Role chip. */
  guest?: { version: string; role: "Editor" | "Commenter" | "Viewer" };
  recent?: readonly string[];
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  onInvite?: () => void;
  onPalette?: () => void;
  onMenuCommand?: (command: string) => void;
};

const MAX_AVATARS = 3;

function ProjectMenu({
  title,
  recent = [],
  onCommand,
}: Pick<AppHeaderProps, "title" | "recent"> & {
  onCommand?: (command: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const run = (command: string) => () => {
    setOpen(false);
    onCommand?.(command);
  };
  const rename = verbOf("fixText");
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
      <MenuItem
        shortcut={capsOf(rename.keys[0]).join(" ")}
        onSelect={run("rename")}
      >
        Rename project
      </MenuItem>
      {recent.length > 0 ? (
        <MenuSection label="Recent">
          {recent.slice(0, 5).map((name) => (
            <MenuItem key={name} onSelect={run(`open:${name}`)}>
              {name}
            </MenuItem>
          ))}
        </MenuSection>
      ) : null}
      <MenuItem onSelect={run("projects")}>All projects</MenuItem>
      <MenuItem onSelect={run("settings")}>Settings</MenuItem>
      <MenuItem onSelect={run("agent")}>Connect agent</MenuItem>
      <MenuItem onSelect={run("help")}>Help</MenuItem>
    </Menu>
  );
}

/**
 * The 48 px App header (44 on phone, by container width). Left: Project menu,
 * Save indicator, Undo and Redo. Center: the Stage bar. Right: people, Invite,
 * Palette. The Stage bar and people hide on narrow containers because the
 * phone has the tab bar instead.
 */
export function AppHeader({
  title,
  save,
  stages,
  people = [],
  guest,
  recent,
  canUndo = true,
  canRedo = true,
  onUndo,
  onRedo,
  onInvite,
  onPalette,
  onMenuCommand,
}: AppHeaderProps) {
  const shown = people.slice(0, MAX_AVATARS);
  const extra = people.length - shown.length;
  const canEdit = !guest || guest.role === "Editor";
  const canInvite = !guest;
  return (
    <header className="sys-app-header-host">
      <div className="sys-app-header">
        <div className="sys-header-left">
          {guest ? (
            <div className="sys-header-guest">
              <span className="sys-header-title">{title}</span>
              <span className="sys-header-sub">
                <span className="sys-mono">{guest.version}</span>
                <Pill>{guest.role}</Pill>
              </span>
            </div>
          ) : (
            <ProjectMenu
              title={title}
              recent={recent}
              onCommand={onMenuCommand}
            />
          )}
          <SaveIndicator compact {...save} />
          {canEdit ? (
            <>
              <VerbButton verb="undo" disabled={!canUndo} onClick={onUndo} />
              <VerbButton verb="redo" disabled={!canRedo} onClick={onRedo} />
            </>
          ) : null}
        </div>
        {stages ? (
          <div className="sys-header-stages">
            <StageBar {...stages} />
          </div>
        ) : null}
        <div className="sys-header-right">
          {shown.length > 0 ? (
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
            </ul>
          ) : null}
          {canInvite ? <VerbButton verb="invite" onClick={onInvite} /> : null}
          <VerbButton verb="palette" onClick={onPalette} />
        </div>
      </div>
    </header>
  );
}
