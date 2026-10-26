import type { ProjectCardData } from "./ProjectCard";

/** Deterministic peaks, so a story renders the same every time. */
export function peaksOf(seed: number, count = 48): number[] {
  return Array.from({ length: count }, (_, index) => {
    const wave = Math.sin(index * 0.55 + seed) * Math.cos(index * 0.17 + seed);
    return Math.round((0.25 + Math.abs(wave) * 0.7) * 100) / 100;
  });
}

export const PROJECTS: ProjectCardData[] = [
  {
    id: "rosa",
    name: "Rosa and Maya, week 42",
    meta: "52:10 · edited 2 h ago",
    stage: "review",
    chip: { text: "Review 6", state: "needs-you" },
    peaks: peaksOf(1),
  },
  {
    id: "garden",
    name: "The garden episode",
    meta: "38:45 · edited yesterday",
    stage: "prepare",
    chip: { text: "Processing 40%", state: "running" },
    peaks: peaksOf(2),
  },
  {
    id: "audit",
    name: "Listener questions",
    meta: "24:02 · edited 3 days ago",
    stage: "edit",
    chip: { text: "Edited", state: "done" },
    peaks: peaksOf(3),
  },
  {
    id: "live",
    name: "Live from the studio with a very long guest name that wraps",
    meta: "1:04:30 · edited 24 Oct",
    stage: "deliver",
    chip: { text: "Delivered 24 Oct", state: "done" },
    peaks: peaksOf(4),
  },
];

export const MISSING: ProjectCardData = {
  ...PROJECTS[2],
  id: "moved",
  folderMissing: true,
};
