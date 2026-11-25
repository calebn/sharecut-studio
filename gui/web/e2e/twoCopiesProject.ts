import fs from "node:fs";
import type { Page } from "@playwright/test";
import { postDocumentCommand } from "./documentCommand";
import { createRelocatedE2eProject } from "./liveProject";

/** A project with two copies of one clip, so a host fade on the second makes a guest's queued cut stale. */
export function twoCopiesProject(prefix: string) {
  const copy = createRelocatedE2eProject(prefix);
  const data = JSON.parse(fs.readFileSync(copy.projectPath, "utf8"));
  const clip = {
    track_id: "reference",
    source_start: 0,
    source_end: 5,
    fade_in_ms: 0,
    fade_out_ms: 0,
    join_in_mode: "fade",
    source_id: null,
  };
  data.timeline.clips = [
    { ...clip, id: "first-copy", timeline_start: 0 },
    { ...clip, id: "second-copy", timeline_start: 10 },
    {
      ...clip,
      id: "peer",
      track_id: "guest",
      source_end: 20,
      timeline_start: 0,
    },
  ];
  data.timeline.duration_sec = 20;
  data.editorial.edit_decisions = [];
  data.editorial.edit_log = [];
  fs.writeFileSync(copy.projectPath, `${JSON.stringify(data, null, 2)}\n`);
  return copy;
}

/** The host fades the second copy in: any cut sealed before this is refused, and it is one more change a guest's saved copy must follow. */
export async function hostEditsTheAudio(host: Page, projectPath: string) {
  await postDocumentCommand(
    host,
    "e2e-host",
    "SetClipFade",
    {
      clip_id: "second-copy",
      fade_in_ms: 40,
      fade_out_ms: 0,
      expected: { fade_in_ms: 0, fade_out_ms: 0 },
    },
    projectPath,
  );
}
