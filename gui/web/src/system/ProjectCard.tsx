import { type KeyboardEvent, useRef, useState } from "react";
import { Button } from "../ui";
import { OverviewStrip } from "./OverviewStrip";
import { StatusPill } from "./StatusPill";
import type { StatusState } from "./statusText";

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
  onKeyDown,
  onFocus,
}: ProjectCardProps) {
  const missing = project.folderMissing === true;
  const chip = missing
    ? { text: "Folder moved", state: "needs-you" as const }
    : project.chip;
  return (
    <div
      className={`sys-project sys-project--${variant}`}
      data-busy={busy || undefined}
      data-missing={missing || undefined}
    >
      <button
        type="button"
        className="sys-project-open"
        tabIndex={tabIndex}
        aria-disabled={missing || undefined}
        aria-busy={busy || undefined}
        data-project-open=""
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
      {missing && onFind ? (
        <Button
          className="sys-project-find"
          onClick={() => onFind(project.id)}
          aria-label={`Find ${project.name}`}
        >
          Find…
        </Button>
      ) : null}
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
};

/** Recent projects as a list with one tab stop and arrow, Home and End keys. */
export function ProjectCardList({
  projects,
  variant = "card",
  label,
  busyId,
  onOpen,
  onFind,
}: ProjectCardListProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const found = projects.findIndex((project) => project.id === activeId);
  const current = found < 0 ? 0 : found;

  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
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
            onKeyDown={move}
            onFocus={() => setActiveId(project.id)}
          />
        </li>
      ))}
    </ul>
  );
}
