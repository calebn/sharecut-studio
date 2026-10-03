import { minimalProject, sampleComment, sampleTrack } from "../test/fixtures";
import { transportTimecode } from "../utils/time";

export const shellProject = minimalProject({
  meta: { name: "Field notes", workspace_dir: "/fictional/field-notes" },
  tracks: [sampleTrack({ id: "mira", label: "Mira", speaker: "Mira" })],
  comments: [
    sampleComment({
      id: "note",
      author: "Avery",
      body: "Keep this introduction.",
    }),
  ],
});
export const shellTime = transportTimecode(12.5, 60);
