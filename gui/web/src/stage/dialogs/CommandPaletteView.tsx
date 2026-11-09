import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { SystemIcon } from "../../system/SystemIcon";
import { Button, Dialog } from "../../ui";
import { claimEscape } from "../../ui/modalGate";
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
  type PaletteGesture,
  searchPaletteCommands,
  searchPaletteEntries,
  searchPaletteGestures,
} from "./paletteSearch";

/** One option in render order, in Recent or its own group. */
type Row =
  | { kind: "command"; key: string; command: PaletteCommand }
  | { kind: "entry"; key: string; entry: PaletteEntry }
  | { kind: "gesture"; key: string; gesture: PaletteGesture };

type Section = { key: string; label: string | null; rows: Row[] };

const commandRow = (command: PaletteCommand, key = command.id): Row => ({
  kind: "command",
  key,
  command,
});
const entryRow = (entry: PaletteEntry, key = entry.id): Row => ({
  kind: "entry",
  key,
  entry,
});

export interface CommandPaletteViewProps {
  open: boolean;
  /** Runnable catalog commands in category order (see `paletteCommands`). */
  commands: readonly PaletteCommand[];
  onClose: () => void;
  onRun: (id: string) => void;
  onRemap: (id: string, trimmedKey: string) => void;
  /** Projects, People and Chapters rows (see `paletteEntries`); none by default. */
  entries?: readonly PaletteEntry[];
  /** Touch gesture rows (`PALETTE_GESTURES` on a coarse pointer); none by default. */
  gestures?: readonly PaletteGesture[];
  /** Ids (command ids or entry ids) last run, newest first; shown as Recent when Search is empty. */
  recent?: readonly string[];
  onRunEntry?: (entry: PaletteEntry) => void;
  /** Group listed first, with its first runnable row active, while Search is empty (Home opens on Help). */
  leadGroup?: "help";
}

/**
 * Store-free command palette: search every runnable command by name, keyword,
 * category or shortcut, run it, and read or remap its keys. Tab on a keyed row
 * opens its key field in place. Open via ?, Menu → Help, or More → Commands and
 * shortcuts on phones.
 *
 * Search is a combobox over a listbox of commands. Focus stays in Search;
 * the arrow keys move the active command (`aria-activedescendant`), unavailable
 * ones included so their reasons are read, and Enter runs it. Typing makes the
 * first runnable match active. The status line names the command Enter runs.
 * With Search empty, Recent comes first, then the commands by category, then
 * the Stages group (the Go to <stage> commands), Projects, People, Chapters,
 * Gestures (touch only, one row per gesture; Enter does nothing) and Help
 * (`help.*` commands), as labelled groups left out while empty. Searching lists
 * commands flat, ranked, with the entry groups and Gestures after them. Command rows show their verb icon.
 */
export function CommandPaletteView({
  open,
  commands,
  onClose,
  onRun,
  onRemap,
  entries = [],
  gestures = [],
  recent = [],
  onRunEntry,
  leadGroup,
}: CommandPaletteViewProps) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  /** Command id whose key field is open in its row; null while browsing. */
  const [remapOpenId, setRemapOpenId] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  const searchRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const listboxId = `${baseId}-commands`;
  const optionId = (key: string) => `${baseId}-opt-${rowIndex.get(key)}`;

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setQuery("");
      setRemapOpenId(null);
      setPicked(null);
    }
  }

  const searching = query.trim() !== "";
  const shown = searchPaletteCommands(commands, query);
  const entriesShown = searchPaletteEntries(entries, query);
  const gesturesShown = searchPaletteGestures(gestures, query);
  const grouped = (group: PaletteCommandGroup): Section[] => {
    const rows = shown.filter((c) => c.group === group);
    return rows.length === 0
      ? []
      : [
          {
            key: group,
            label: PALETTE_COMMAND_GROUP_LABELS[group],
            rows: rows.map((command) => commandRow(command)),
          },
        ];
  };

  const sections: Section[] = [];
  if (!searching) {
    if (leadGroup) {
      sections.push(...grouped(leadGroup));
    }
    const recentRows: Row[] = [];
    for (const id of recent) {
      const command = commands.find((c) => c.id === id);
      const entry = entries.find((e) => e.id === id);
      if (command && command.disabledReason == null) {
        recentRows.push(commandRow(command, `recent:${id}`));
      } else if (entry) {
        recentRows.push(entryRow(entry, `recent:${id}`));
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
        rows: rows.map((command) => commandRow(command)),
      });
    }
  } else if (shown.length > 0) {
    sections.push({
      key: "commands",
      label: null,
      rows: shown.map((command) => commandRow(command)),
    });
  }
  if (!searching) {
    sections.push(...grouped("stages"));
  }
  for (const { group, rows } of groupPaletteEntries(entriesShown)) {
    sections.push({
      key: group,
      label: PALETTE_ENTRY_GROUP_LABELS[group],
      rows: rows.map((entry) => entryRow(entry)),
    });
  }
  if (gesturesShown.length > 0) {
    sections.push({
      key: "gestures",
      label: PALETTE_GESTURES_LABEL,
      rows: gesturesShown.map((gesture) => ({
        kind: "gesture",
        key: gesture.id,
        gesture,
      })),
    });
  }
  if (!searching && !leadGroup) {
    sections.push(...grouped("help"));
  }
  const rows = sections.flatMap((section) => section.rows);
  const rowIndex = new Map(rows.map((row, i) => [row.key, i]));
  const extra = entriesShown.length + gesturesShown.length;
  const total = shown.length + extra;

  const remapRow = rows.find(
    (r) => r.kind === "command" && r.command.id === remapOpenId,
  );
  const remapping = remapRow != null;
  const listed = !remapping && rows.length > 0;
  const rowDisabled = (row: Row) =>
    row.kind === "command" && row.command.disabledReason != null;
  const active = !remapping
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
    if (row.kind === "command") {
      if (row.command.disabledReason == null) {
        onRun(row.command.id);
      }
    } else if (row.kind === "entry") {
      onRunEntry?.(row.entry);
    }
  }

  function finishRemap(trimmedKey: string | undefined) {
    if (remapOpenId != null && trimmedKey !== undefined) {
      onRemap(remapOpenId, trimmedKey);
    }
    setRemapOpenId(null);
    searchRef.current?.focus();
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
    } else if (
      e.key === "Tab" &&
      !e.shiftKey &&
      active?.kind === "command" &&
      active.command.defaultKey != null
    ) {
      e.preventDefault();
      // The dialog's Tab trap must not also move focus.
      e.stopPropagation();
      setRemapOpenId(active.command.id);
    }
  }

  const activeStatus = !active
    ? ""
    : active.kind === "gesture"
      ? `${active.gesture.gesture}: ${active.gesture.action}`
      : active.kind === "entry"
        ? `Enter: ${active.entry.verb} ${active.entry.label}`
        : active.command.disabledReason == null
          ? `Enter runs ${active.command.label}${active.command.defaultKey != null ? ". Tab remaps" : ""}`
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
      row={row}
      active={row.key === active?.key}
      showCategory={showCategory}
      plain={remapping}
      onRun={() => runRow(row)}
    >
      {row === remapRow && row.kind === "command" ? (
        <RemapField command={row.command} onDone={finishRemap} />
      ) : null}
    </PaletteOption>
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
      <p className="command-palette-count" role="status">
        {status}
      </p>

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
      {listed || remapping ? (
        <div
          id={listed ? listboxId : undefined}
          role={listed ? "listbox" : undefined}
          aria-label={listed ? "Commands" : undefined}
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

/** Without `plain` the row is a listbox option; with it (a key field is open) a generic row, since a field cannot sit inside an option. */
function PaletteOption({
  id,
  row,
  active,
  showCategory,
  plain,
  onRun,
  children,
}: {
  id: string;
  row: Row;
  active: boolean;
  showCategory: boolean;
  plain: boolean;
  onRun: () => void;
  children?: ReactNode;
}) {
  const disabled = row.kind === "command" && row.command.disabledReason != null;
  const command = row.kind === "command" ? row.command : undefined;
  const label =
    row.kind === "command"
      ? row.command.label
      : row.kind === "entry"
        ? row.entry.label
        : row.gesture.action;
  const note =
    row.kind === "command"
      ? (row.command.disabledReason ?? row.command.note)
      : row.kind === "entry"
        ? row.entry.context
        : row.gesture.description;
  const keys = row.kind === "command" ? row.command.shortcut : null;
  const keysId = `${id}-keys`;
  const noteId = `${id}-note`;
  const labelledBy = [
    `${id}-label`,
    keys ? keysId : null,
    row.kind === "gesture" ? keysId : null,
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
      role={plain ? undefined : "option"}
      tabIndex={plain ? undefined : -1}
      aria-selected={plain ? undefined : active}
      aria-disabled={plain ? undefined : disabled || undefined}
      aria-labelledby={plain ? undefined : labelledBy}
      data-remap-open={children ? "" : undefined}
      className="command-palette-option"
      // Keep focus in Search, which owns the keyboard.
      onMouseDown={(e) => {
        if (!plain) {
          e.preventDefault();
        }
      }}
      onClick={plain ? undefined : run}
      // Search owns the keyboard; this covers assistive tech that moves real
      // focus onto an option.
      onKeyDown={
        plain
          ? undefined
          : (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                run();
              }
            }
      }
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
        {keys ? (
          <>
            {" "}
            <kbd id={keysId}>{keys}</kbd>
          </>
        ) : null}
        {row.kind === "gesture" ? (
          <>
            {" "}
            <span id={keysId} className="command-palette-gesture">
              {row.gesture.gesture}
            </span>
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
      {children}
    </div>
  );
}

/** A keyed command's key field, open in its row. */
function RemapField({
  command,
  onDone,
}: {
  command: PaletteCommand;
  /** undefined cancels; a string commits that trimmed key, "" restoring the default. */
  onDone: (trimmedKey: string | undefined) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const dirty = useRef(false);
  const done = useRef(false);
  useLayoutEffect(() => {
    ref.current?.focus();
  }, []);
  // Leaving the field blurs it too; the first outcome wins.
  const finish = (trimmedKey: string | undefined) => {
    if (!done.current) {
      done.current = true;
      onDone(trimmedKey);
    }
  };
  const typed = (input: HTMLInputElement) =>
    dirty.current ? input.value.trim() : undefined;
  return (
    <label className="command-palette-remap">
      Remap
      <input
        ref={ref}
        aria-label={`Remap ${command.label}`}
        placeholder={command.defaultKey}
        onChange={() => {
          dirty.current = true;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            finish(e.currentTarget.value.trim());
          } else if (e.key === "Escape") {
            if (claimEscape(e.nativeEvent)) {
              e.preventDefault();
              finish(undefined);
            }
          } else if (e.key === "Tab") {
            e.preventDefault();
            e.stopPropagation();
            finish(typed(e.currentTarget));
          }
        }}
        onBlur={(e) => finish(typed(e.currentTarget))}
      />
    </label>
  );
}
