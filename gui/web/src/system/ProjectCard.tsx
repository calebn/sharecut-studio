import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type Ref,
  useRef,
  useState,
} from "react";
import { useLongPress } from "../hooks/useLongPress";
import { Button, Menu, MenuItem } from "../ui";
import { OverviewStrip } from "./OverviewStrip";
import { StatusPill } from "./StatusPill";
import { SystemIcon } from "./SystemIcon";
import type { StatusState } from "./statusText";
import { useSwipeReveal } from "./useSwipeReveal";

export type ProjectCardData = {
  id: string;
  name: string;
  /** Formatted by the caller: "52:10 · edited 2 h ago". */
  meta: string;
  /** Where the card opens: the stage its chip names. */
  stage: "record" | "prepare" | "review" | "edit" | "deliver";
  chip: { text: string; state: StatusState };
  /** Whole-episode peak heights, 0 to 1. */
  peaks: number[];
  /** The folder moved: the card offers Find instead of opening. */
  folderMissing?: boolean;
};

/** What a card's menu can do besides open it; a card with none has no menu. */
export type ProjectCardActions = {
  onReveal: (id: string) => void;
  onDuplicate: (id: string) => void;
  /** Takes the card off the list; the episode and its folder stay. */
  onRemove: (id: string) => void;
};

type ProjectCardProps = {
  project: ProjectCardData;
  /** `card` 240 x 152, `row` 72 px (phone, Project menu). */
  variant?: "card" | "row";
  /** Roving tabindex: only the active card is in the tab order. */
  tabIndex?: 0 | -1;
  /** The card being opened: marked busy until the open settles. */
  busy?: boolean;
  onOpen: (id: string, stage: ProjectCardData["stage"]) => void;
  /** Shown beside the card button when the folder is missing. */
  onFind?: (id: string) => void;
  actions?: ProjectCardActions;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onFocus?: () => void;
};

/**
 * One recent project: a single button named by the project, with its meta and
 * stage chip as the description. Wrap in `li`; arrows live in the list.
 */
function ProjectCard({
  project,
  variant = "card",
  tabIndex = 0,
  busy = false,
  onOpen,
  onFind,
  actions,
  onKeyDown,
  onFocus,
}: ProjectCardProps) {
  const missing = project.folderMissing === true;
  const chip = missing
    ? { text: "Folder moved", state: "needs-you" as const }
    : project.chip;
  const [menuOpen, setMenuOpen] = useState(false);
  const pointerType = useRef("");
  const cardRef = useRef<HTMLDivElement>(null);
  const swipe = useSwipeReveal(
    variant === "row" && actions !== undefined,
    cardRef,
  );
  const longPress = useLongPress(() => setMenuOpen(true));
  const remove = actions?.onRemove;
  const menu = (
    <>
      {missing ? null : (
        <>
          <MenuItem
            onSelect={() => {
              setMenuOpen(false);
              onOpen(project.id, project.stage);
            }}
          >
            <SystemIcon name="arrow-right" size={16} />
            Open
          </MenuItem>
          <MenuItem
            onSelect={() => {
              setMenuOpen(false);
              actions?.onReveal(project.id);
            }}
          >
            <SystemIcon name="folder-open" size={16} />
            Reveal in folder
          </MenuItem>
          <MenuItem
            onSelect={() => {
              setMenuOpen(false);
              actions?.onDuplicate(project.id);
            }}
          >
            <SystemIcon name="copy" size={16} />
            Duplicate
          </MenuItem>
        </>
      )}
      <MenuItem
        onSelect={() => {
          setMenuOpen(false);
          remove?.(project.id);
        }}
      >
        <SystemIcon name="x" size={16} />
        Remove from list
      </MenuItem>
    </>
  );
  const openButton = (triggerRef?: Ref<HTMLButtonElement>) => (
    <button
      ref={triggerRef}
      type="button"
      className="sys-project-open"
      tabIndex={tabIndex}
      aria-disabled={missing || undefined}
      aria-busy={busy || undefined}
      data-project-open=""
      data-project-id={project.id}
      onClick={missing ? undefined : () => onOpen(project.id, project.stage)}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
    >
      <span className="sys-project-strip" aria-hidden="true">
        <OverviewStrip
          height={48}
          peaks={project.peaks}
          label={`${project.name} overview`}
        />
      </span>
      <span className="sys-project-name">{project.name}</span>
      <span className="sys-project-meta">{project.meta}</span>
      <span className="sys-project-chip">
        <StatusPill state={chip.state} text={chip.text} />
      </span>
    </button>
  );
  const find =
    missing && onFind ? (
      <Button
        className="sys-project-find"
        onClick={() => onFind(project.id)}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        aria-label={`Find ${project.name}`}
      >
        Find…
      </Button>
    ) : null;
  if (!actions) {
    return (
      <div
        className={`sys-project sys-project--${variant}`}
        data-busy={busy || undefined}
        data-missing={missing || undefined}
      >
        <div className="sys-project-slide">
          {openButton()}
          {find}
        </div>
      </div>
    );
  }
  const press = (event: ReactPointerEvent<HTMLElement>) => {
    pointerType.current = event.pointerType;
    longPress.onPointerDown(event);
    swipe.handlers.onPointerDown(event);
  };
  return (
    <div
      className={`sys-project sys-project--${variant}`}
      data-busy={busy || undefined}
      data-missing={missing || undefined}
      data-revealed={swipe.revealed || undefined}
      ref={cardRef}
    >
      {variant === "row" ? (
        <button
          type="button"
          className="sys-project-remove"
          tabIndex={swipe.revealed ? 0 : -1}
          aria-label={`Remove ${project.name} from list`}
          onClick={() => remove?.(project.id)}
        >
          Remove from list
        </button>
      ) : null}
      <div
        className="sys-project-slide"
        data-dragging={swipe.dragging || undefined}
        style={swipe.style}
        onKeyDownCapture={() => {
          pointerType.current = "";
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          if (pointerType.current !== "touch") setMenuOpen(true);
        }}
        onPointerDown={press}
        onPointerMove={(event) => {
          longPress.onPointerMove(event);
          swipe.handlers.onPointerMove(event);
        }}
        onPointerUp={(event) => {
          longPress.onPointerUp(event);
          swipe.handlers.onPointerUp(event);
        }}
        onPointerCancel={(event) => {
          longPress.onPointerCancel(event);
          swipe.handlers.onPointerCancel();
        }}
        onClickCapture={(event) => {
          longPress.onClickCapture(event);
          swipe.handlers.onClickCapture(event);
        }}
      >
        <Menu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          label={`${project.name}: actions`}
          className="ui-menu-root sys-menu sys-project-menu"
          trigger={({ ref }) => openButton(ref)}
        >
          {menu}
        </Menu>
        {find}
      </div>
    </div>
  );
}

export type ProjectCardListProps = {
  projects: readonly ProjectCardData[];
  variant?: "card" | "row";
  /** Names the list for assistive technology: "Recent episodes". */
  label: string;
  /** The id of the card being opened, if any. */
  busyId?: string;
  onOpen: (id: string, stage: ProjectCardData["stage"]) => void;
  onFind?: (id: string) => void;
  /** Right-click or long-press menu, and on the row layout a swipe to Remove from list. */
  actions?: ProjectCardActions;
};

/** Recent projects as a list with one tab stop and arrow, Home and End keys. */
export function ProjectCardList({
  projects,
  variant = "card",
  label,
  busyId,
  onOpen,
  onFind,
  actions,
}: ProjectCardListProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const found = projects.findIndex((project) => project.id === activeId);
  const current = found < 0 ? 0 : found;

  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
    // Alt+Left is the browser's Back; modified arrows are not ours.
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    const last = projects.length - 1;
    const keys: Record<string, number> = {
      ArrowRight: Math.min(current + 1, last),
      ArrowDown: Math.min(current + 1, last),
      ArrowLeft: Math.max(current - 1, 0),
      ArrowUp: Math.max(current - 1, 0),
      Home: 0,
      End: last,
    };
    const next = keys[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setActiveId(projects[next].id);
    listRef.current
      ?.querySelectorAll<HTMLButtonElement>("[data-project-open]")
      [next]?.focus();
  };

  const cardActions: ProjectCardActions | undefined = actions && {
    ...actions,
    onRemove: (id) => {
      const index = projects.findIndex((project) => project.id === id);
      const next = projects[index + 1] ?? projects[index - 1];
      setActiveId(next?.id ?? null);
      actions.onRemove(id);
      if (!next) return;
      requestAnimationFrame(() => {
        for (const button of listRef.current?.querySelectorAll<HTMLElement>(
          "[data-project-id]",
        ) ?? []) {
          if (button.dataset.projectId === next.id) button.focus();
        }
      });
    },
  };
  return (
    <ul
      ref={listRef}
      className={`sys-project-list sys-project-list--${variant}`}
      aria-label={label}
    >
      {projects.map((project, index) => (
        <li key={project.id}>
          <ProjectCard
            project={project}
            variant={variant}
            tabIndex={index === current ? 0 : -1}
            busy={project.id === busyId}
            onOpen={onOpen}
            onFind={onFind}
            actions={cardActions}
            onKeyDown={move}
            onFocus={() => setActiveId(project.id)}
          />
        </li>
      ))}
    </ul>
  );
}
