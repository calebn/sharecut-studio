import type { ProjectCardData } from "../../system/ProjectCard";

const SPEECH = [
  0.3, 0.55, 0.72, 0.4, 0.62, 0.8, 0.5, 0.35, 0.66, 0.78, 0.45, 0.58, 0.7, 0.33,
  0.52, 0.84, 0.6, 0.38, 0.47, 0.74, 0.68, 0.42, 0.56, 0.79, 0.36, 0.63, 0.71,
  0.49, 0.54, 0.82, 0.41, 0.6, 0.69, 0.37, 0.76, 0.5, 0.58, 0.44, 0.73, 0.65,
];
const QUIET = [
  0.2, 0.28, 0.35, 0.3, 0.22, 0.4, 0.55, 0.62, 0.48, 0.3, 0.25, 0.33, 0.5, 0.67,
  0.58, 0.4, 0.27, 0.23, 0.36, 0.52, 0.6, 0.45, 0.31, 0.26, 0.38, 0.57, 0.64,
  0.5, 0.34, 0.24, 0.29, 0.46, 0.61, 0.53, 0.37, 0.28, 0.32, 0.49, 0.56, 0.42,
];
const LOUD = [
  0.6, 0.78, 0.9, 0.7, 0.85, 0.95, 0.74, 0.66, 0.88, 0.92, 0.72, 0.8, 0.86,
  0.64, 0.76, 0.93, 0.82, 0.68, 0.71, 0.89, 0.84, 0.7, 0.77, 0.91, 0.65, 0.83,
  0.87, 0.73, 0.79, 0.94, 0.69, 0.81, 0.85, 0.67, 0.9, 0.75, 0.8, 0.72, 0.88,
  0.78,
];

/** Recent episodes with every stage chip state, for the Home stories. */
export const RECENTS: ProjectCardData[] = [
  {
    id: "rosa",
    name: "Rosa and Maya, week 42",
    meta: "52:10 · edited 2 h ago",
    stage: "review",
    chip: { text: "Review 6", state: "needs-you" },
    peaks: SPEECH,
  },
  {
    id: "garden",
    name: "The garden episode",
    meta: "38:45 · edited yesterday",
    stage: "prepare",
    chip: { text: "Processing 40%", state: "running" },
    peaks: QUIET,
  },
  {
    id: "audit",
    name: "Listener questions",
    meta: "24:02 · edited 3 days ago",
    stage: "edit",
    chip: { text: "Edited", state: "done" },
    peaks: LOUD,
  },
  {
    id: "live",
    name: "Live from the studio with a very long guest name that wraps",
    meta: "1:04:30 · edited 24 Oct",
    stage: "deliver",
    chip: { text: "Delivered 24 Oct", state: "done" },
    peaks: SPEECH,
  },
  {
    id: "take",
    name: "Tuesday take",
    meta: "0:12 · edited just now",
    stage: "record",
    chip: { text: "Recording", state: "live" },
    peaks: QUIET,
  },
  {
    id: "stuck",
    name: "Winter special",
    meta: "47:30 · edited last week",
    stage: "prepare",
    chip: { text: "Needs attention", state: "failed" },
    peaks: LOUD,
  },
];

/** The same list with one folder moved. */
export const RECENTS_MOVED: ProjectCardData[] = RECENTS.map((project) =>
  project.id === "audit" ? { ...project, folderMissing: true } : project,
);
