import { type KeyboardEvent, useId, useRef, useState } from "react";
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

export type ProjectCardProps = {
  project: ProjectCardData;
  /** `card` 240 x 152, `row` 72 px (phone, Project menu). */
  variant?: "card" | "row";
  /** Roving tabindex: 0 for the one card in the tab order, -1 for the rest. */
  tabIndex?: 0 | -1;
  /** The card Enter continues from: a visual ring only, it takes no focus. */
  primary?: boolean;
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
export function ProjectCard({
  project,
  variant = "card",
  tabIndex = 0,
  primary = false,
  onOpen,
  onFind,
  onKeyDown,
  onFocus,
}: ProjectCardProps) {
  const nameId = useId();
  const metaId = useId();
  const chipId = useId();
  const missing = project.folderMissing === true;
  const chip = missing
    ? { text: "Folder moved", state: "needs-you" as const }
    : project.chip;
  return (
    <div
      className={`sys-project sys-project--${variant}`}
      data-primary={primary || undefined}
      data-missing={missing || undefined}
    >
      <button
        type="button"
        className="sys-project-open"
        tabIndex={tabIndex}
        aria-disabled={missing || undefined}
        aria-labelledby={nameId}
        aria-describedby={`${metaId} ${chipId}`}
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
        <span id={nameId} className="sys-project-name">
          {project.name}
        </span>
        <span id={metaId} className="sys-project-meta">
          {project.meta}
        </span>
        <span id={chipId} className="sys-project-chip">
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
  /** The card with the ring. Defaults to the first project. */
  primaryId?: string;
  onOpen: (id: string, stage: ProjectCardData["stage"]) => void;
  onFind?: (id: string) => void;
};

/** Recent projects as a list with one tab stop and arrow, Home and End keys. */
export function ProjectCardList({
  projects,
  variant = "card",
  label,
  primaryId,
  onOpen,
  onFind,
}: ProjectCardListProps) {
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const current = Math.min(active, Math.max(projects.length - 1, 0));
  const ringId = primaryId ?? projects[0]?.id;

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
    setActive(next);
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
            primary={project.id === ringId}
            onOpen={onOpen}
            onFind={onFind}
            onKeyDown={move}
            onFocus={() => setActive(index)}
          />
        </li>
      ))}
    </ul>
  );
}
