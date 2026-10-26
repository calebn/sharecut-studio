import { useState } from "react";
import { Avatar, BrandSymbol, Menu, MenuItem, MenuSection, Pill } from "../ui";
import type { SystemIconName } from "./icons";
import { SaveIndicator, type SaveIndicatorProps } from "./SaveIndicator";
import { StageBar, type StageBarProps } from "./StageBar";
import { SystemIcon } from "./SystemIcon";
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
  onMenuCommand?: (command: string) => void;
};

const MAX_AVATARS = 3;

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
  onCommand,
  onRename,
}: Pick<AppHeaderProps, "title" | "recent" | "onRename"> & {
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
      <MenuItem
        shortcut={capsOf(rename.keys[0]).join(" ")}
        onSelect={() => {
          setOpen(false);
          onRename?.();
        }}
      >
        <span className="sys-menu-field">
          <SystemIcon name="text-cursor-input" size={16} />
          <span className="sr-only">Rename project, </span>
          <span className="sys-menu-field-text">{title}</span>
        </span>
      </MenuItem>
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
      <MenuItem onSelect={run("settings")}>
        <Row icon="settings">Settings</Row>
      </MenuItem>
      <MenuItem onSelect={run("agent")}>
        <Row icon="plug">Connect agent</Row>
      </MenuItem>
      <MenuItem onSelect={run("help")}>
        <Row icon="circle-help">Help</Row>
      </MenuItem>
    </Menu>
  );
}

/**
 * The 48 px App header (44 on phone, by container width). Left: Project menu,
 * Save indicator, Undo and Redo. Center: the Stage bar. Right: people, Invite,
 * Palette. Below 40rem (the phone) the Stage bar and people hide, because the
 * phone has the tab bar, and the Save indicator shrinks to its glyph.
 */
export function AppHeader({
  title,
  save,
  stages,
  people = [],
  guest,
  recent,
  loading = false,
  canUndo = true,
  canRedo = true,
  onUndo,
  onRedo,
  onInvite,
  onPalette,
  onRename,
  onMenuCommand,
}: AppHeaderProps) {
  const shown = people.slice(0, MAX_AVATARS);
  const extra = people.length - shown.length;
  const canEdit = !guest || guest.role === "Editor";
  return (
    <header className="sys-app-header-host" aria-busy={loading || undefined}>
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
              onRename={onRename}
            />
          )}
          {loading ? null : <SaveIndicator {...save} />}
          {canEdit ? (
            <>
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
          {canEdit ? <VerbButton verb="invite" onClick={onInvite} /> : null}
          <VerbButton verb="palette" onClick={onPalette} />
        </div>
      </div>
    </header>
  );
}
