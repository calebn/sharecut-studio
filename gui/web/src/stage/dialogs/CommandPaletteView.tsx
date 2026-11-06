import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { SystemIcon } from "../../system/SystemIcon";
import { Button, Dialog } from "../../ui";
import {
  groupPaletteCommands,
  groupPaletteEntries,
  PALETTE_CATEGORY_LABELS,
  PALETTE_COMMAND_GROUP_LABELS,
  PALETTE_ENTRY_GROUP_LABELS,
  PALETTE_GESTURES_LABEL,
  PALETTE_RECENT_LIMIT,
  type PaletteCommand,
  type PaletteCommandGroup,
  type PaletteEntry,
  paletteGesturesMatch,
  searchPaletteCommands,
  searchPaletteEntries,
} from "./paletteSearch";

/** One option in render order: a command, an entry or the Gestures row, in Recent or its own group. */
type Row = {
  /** Unique in the list (Recent repeats an id the groups below also show). */
  key: string;
  command?: PaletteCommand;
  entry?: PaletteEntry;
  /** The Gestures row: opens the Gestures sheet. */
  gestures?: true;
};

const GESTURES_ROW: Row = { key: "gestures:open", gestures: true };

type Section = { key: string; label: string | null; rows: Row[] };

const GESTURES_SECTION: Section = {
  key: "gestures",
  label: PALETTE_GESTURES_LABEL,
  rows: [GESTURES_ROW],
};

export interface CommandPaletteViewProps {
  open: boolean;
  /** Runnable catalog commands in category order (see `paletteCommands`). */
  commands: readonly PaletteCommand[];
  onClose: () => void;
  onOpenGestures: () => void;
  onRun: (id: string) => void;
  onRemap: (id: string, trimmedKey: string) => void;
  /** Projects, People and Chapters rows (see `paletteEntries`); none by default. */
  entries?: readonly PaletteEntry[];
  /** Ids (command ids or entry ids) last run, newest first; shown as Recent when Search is empty. */
  recent?: readonly string[];
  onRunEntry?: (entry: PaletteEntry) => void;
  /** Group listed first, with its first runnable row active, while Search is empty (Home opens on Help). */
  leadGroup?: "help";
}

/**
 * Store-free command palette: search every runnable command by name, keyword,
 * category or shortcut, run it, and read or remap its keys. Open via ?, Menu →
 * Help, or More → Commands and shortcuts on phones.
 *
 * Search is a combobox over a listbox of commands. Focus stays in Search;
 * the arrow keys move the active command (`aria-activedescendant`), unavailable
 * ones included so their reasons are read, and Enter runs it. Typing makes the
 * first runnable match active. The status line names the command Enter runs.
 * With Search empty, Recent comes first, then the commands by category, then
 * the Stages group (the Go to <stage> commands), Projects, People, Chapters,
 * Gestures (opens the Gestures sheet) and Help (`help.*` commands), as labelled
 * groups left out while empty. Searching lists commands flat, ranked, with the
 * entry groups and Gestures after them. Command rows show their verb icon.
 */
export function CommandPaletteView({
  open,
  commands,
  onClose,
  onOpenGestures,
  onRun,
  onRemap,
  entries = [],
  recent = [],
  onRunEntry,
  leadGroup,
}: CommandPaletteViewProps) {
  const [query, setQuery] = useState("");
  const [showRemap, setShowRemap] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  const searchRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const listboxId = `${baseId}-commands`;
  const optionId = (key: string) => `${baseId}-opt-${rowIndex.get(key)}`;

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setQuery("");
      setShowRemap(false);
      setPicked(null);
    }
  }

  const searching = query.trim() !== "";
  const shown = searchPaletteCommands(commands, query);
  const entriesShown = searchPaletteEntries(entries, query);
  const gesturesShown = paletteGesturesMatch(query);
  const grouped = (group: PaletteCommandGroup): Section[] => {
    const rows = shown.filter((c) => c.group === group);
    return rows.length === 0
      ? []
      : [
          {
            key: group,
            label: PALETTE_COMMAND_GROUP_LABELS[group],
            rows: rows.map((command) => ({ key: command.id, command })),
          },
        ];
  };

  const sections: Section[] = [];
  if (!searching) {
    if (leadGroup) {
      sections.push(...grouped(leadGroup));
      if (gesturesShown) {
        sections.push(GESTURES_SECTION);
      }
    }
    const recentRows: Row[] = [];
    for (const id of recent) {
      const command = commands.find((c) => c.id === id);
      const entry = entries.find((e) => e.id === id);
      if (command && command.disabledReason == null) {
        recentRows.push({ key: `recent:${id}`, command });
      } else if (entry) {
        recentRows.push({ key: `recent:${id}`, entry });
      }
      if (recentRows.length === PALETTE_RECENT_LIMIT) {
        break;
      }
    }
    if (recentRows.length > 0) {
      sections.push({ key: "recent", label: "Recent", rows: recentRows });
    }
    for (const { category, rows } of groupPaletteCommands(
      shown.filter((c) => c.group == null),
    )) {
      sections.push({
        key: category,
        label: PALETTE_CATEGORY_LABELS[category],
        rows: rows.map((command) => ({ key: command.id, command })),
      });
    }
  } else if (shown.length > 0) {
    sections.push({
      key: "commands",
      label: null,
      rows: shown.map((command) => ({ key: command.id, command })),
    });
  }
  if (!searching) {
    sections.push(...grouped("stages"));
  }
  for (const { group, rows } of groupPaletteEntries(entriesShown)) {
    sections.push({
      key: group,
      label: PALETTE_ENTRY_GROUP_LABELS[group],
      rows: rows.map((entry) => ({ key: entry.id, entry })),
    });
  }
  if (gesturesShown && !(leadGroup && !searching)) {
    sections.push(GESTURES_SECTION);
  }
  if (!searching && !leadGroup) {
    sections.push(...grouped("help"));
  }
  const rows = sections.flatMap((section) => section.rows);
  const rowIndex = new Map(rows.map((row, i) => [row.key, i]));
  const extra = entriesShown.length + (gesturesShown ? 1 : 0);
  const total = shown.length + extra;

  const listed = !showRemap && rows.length > 0;
  const rowDisabled = (row: Row) => row.command?.disabledReason != null;
  const active = listed
    ? (rows.find((r) => r.key === picked) ??
      (searching || leadGroup
        ? rows.find((r) => !rowDisabled(r))
        : undefined) ??
      null)
    : null;
  const activeDomId = active ? optionId(active.key) : undefined;

  useEffect(() => {
    if (activeDomId) {
      document
        .getElementById(activeDomId)
        ?.scrollIntoView?.({ block: "nearest" });
    }
  }, [activeDomId]);

  function runRow(row: Row) {
    if (row.command) {
      if (row.command.disabledReason == null) {
        onRun(row.command.id);
      }
    } else if (row.entry) {
      onRunEntry?.(row.entry);
    } else if (row.gestures) {
      onOpenGestures();
    }
  }

  function onSearchKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!listed) {
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const at = active ? rows.indexOf(active) : -1;
      const next =
        e.key === "ArrowDown"
          ? Math.min(at + 1, rows.length - 1)
          : Math.max(at - 1, 0);
      setPicked(rows[next]?.key ?? null);
    } else if (e.key === "Enter" && active) {
      e.preventDefault();
      runRow(active);
    }
  }

  const activeStatus = !active
    ? ""
    : active.gestures
      ? "Enter opens Gestures"
      : active.entry
        ? `Enter: ${active.entry.verb} ${active.entry.label}`
        : active.command?.disabledReason == null
          ? `Enter runs ${active.command?.label}`
          : `${active.command.label} is unavailable: ${active.command.disabledReason}`;
  const status = [
    searching
      ? `${total} ${extra > 0 ? (total === 1 ? "result" : "results") : total === 1 ? "command" : "commands"}`
      : "",
    activeStatus,
  ]
    .filter(Boolean)
    .join(". ");

  const option = (row: Row, showCategory: boolean) => (
    <PaletteOption
      key={row.key}
      id={optionId(row.key)}
      command={row.command}
      entry={row.entry}
      gestures={row.gestures}
      active={row.key === active?.key}
      showCategory={showCategory}
      onRun={() => runRow(row)}
    />
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Commands and shortcuts"
      panelClassName="command-palette-dialog"
      initialFocusRef={searchRef}
    >
      <input
        ref={searchRef}
        type="search"
        role="combobox"
        className="command-palette-search"
        aria-label="Search commands"
        aria-autocomplete="list"
        aria-expanded={listed}
        aria-controls={listed ? listboxId : undefined}
        aria-activedescendant={activeDomId}
        placeholder="Search commands"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="go"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setPicked(null);
        }}
        onKeyDown={onSearchKeyDown}
      />
      <p className="command-palette-hint">
        Press <kbd>?</kbd> anytime.{" "}
        {leadGroup === "help"
          ? "On Home, R and Ctrl+I work unless you are typing in a field."
          : "Character keys only apply when the timeline or transcript has focus."}{" "}
        <Button variant="link" onClick={onOpenGestures}>
          Gestures
        </Button>
      </p>
      <div className="command-palette-toolbar">
        <p className="command-palette-count" role="status">
          {status}
        </p>
        <label className="command-palette-remap-toggle">
          <input
            type="checkbox"
            checked={showRemap}
            onChange={(e) => setShowRemap(e.target.checked)}
          />
          Show remaps
        </label>
      </div>

      {searching && total === 0 ? (
        <div className="command-palette-empty">
          <p>
            {entries.length > 0 ? "Nothing matches" : "No commands match"} “
            {query.trim()}”.
          </p>
          <Button
            onClick={() => {
              setQuery("");
              searchRef.current?.focus();
            }}
          >
            Clear search
          </Button>
        </div>
      ) : null}
      {showRemap ? <RemapList rows={shown} onRemap={onRemap} /> : null}
      {listed ? (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Commands"
          className="command-palette-listbox"
        >
          {sections.map((section, i) => {
            if (section.label == null) {
              return section.rows.map((row) => option(row, true));
            }
            // Index-keyed: the same category can head two runs of commands.
            const labelId = `${baseId}-group-${i}`;
            return (
              <div
                key={`${section.key}:${i}`}
                role="group"
                aria-labelledby={labelId}
                className="command-palette-group"
              >
                <div id={labelId} className="command-palette-group-label">
                  {section.label}
                </div>
                {section.rows.map((row) => option(row, false))}
              </div>
            );
          })}
        </div>
      ) : null}
    </Dialog>
  );
}

function PaletteOption({
  id,
  command,
  entry,
  gestures,
  active,
  showCategory,
  onRun,
}: {
  id: string;
  command?: PaletteCommand;
  entry?: PaletteEntry;
  gestures?: true;
  active: boolean;
  showCategory: boolean;
  onRun: () => void;
}) {
  const disabled = command?.disabledReason != null;
  const note = command
    ? (command.disabledReason ?? command.note)
    : gestures
      ? "Touch gestures"
      : entry?.context;
  const label =
    command?.label ?? entry?.label ?? (gestures ? PALETTE_GESTURES_LABEL : "");
  const shortcut = command?.shortcut ?? null;
  const keysId = `${id}-keys`;
  const noteId = `${id}-note`;
  const labelledBy = [
    `${id}-label`,
    shortcut ? keysId : null,
    note ? noteId : null,
  ]
    .filter(Boolean)
    .join(" ");
  const run = () => {
    if (!disabled) {
      onRun();
    }
  };
  return (
    <div
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={active}
      aria-disabled={disabled || undefined}
      aria-labelledby={labelledBy}
      className="command-palette-option"
      // Keep focus in Search, which owns the keyboard.
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
      // Search owns the keyboard; this covers assistive tech that moves real
      // focus onto an option.
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          run();
        }
      }}
    >
      <span className="command-palette-option-main">
        <span id={`${id}-label`} className="command-palette-label">
          {command?.icon ? (
            <SystemIcon
              name={command.icon}
              size={16}
              className="command-palette-icon"
            />
          ) : null}
          {label}
          {showCategory && command ? (
            <>
              {" "}
              <span className="command-palette-category">
                {command.group
                  ? PALETTE_COMMAND_GROUP_LABELS[command.group]
                  : PALETTE_CATEGORY_LABELS[command.category]}
              </span>
            </>
          ) : null}
        </span>
        {shortcut ? (
          <>
            {" "}
            <kbd id={keysId}>{shortcut}</kbd>
          </>
        ) : null}
      </span>
      {note ? (
        <>
          {" "}
          <span id={noteId} className="command-palette-note">
            {note}
          </span>
        </>
      ) : null}
    </div>
  );
}

/** "Show remaps": a key field for each matching command that has keys. */
function RemapList({
  rows,
  onRemap,
}: {
  rows: readonly PaletteCommand[];
  onRemap: (id: string, trimmedKey: string) => void;
}) {
  const keyed = rows.filter((row) => row.defaultKey != null);
  if (keyed.length === 0) {
    return null;
  }
  return (
    <ul className="command-palette-list">
      {keyed.map((row) => (
        <li key={row.id} className="command-palette-remap-row">
          <span className="command-palette-label">{row.label}</span>
          {row.shortcut ? <kbd>{row.shortcut}</kbd> : null}
          <label className="command-palette-remap">
            Remap
            <input
              aria-label={`Remap ${row.label}`}
              placeholder={row.defaultKey}
              onBlur={(e) => {
                onRemap(row.id, e.target.value.trim());
              }}
            />
          </label>
        </li>
      ))}
    </ul>
  );
}
