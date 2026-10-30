import { runPointerCommand } from "../../commands/pointer";
import type { SourceOwner } from "../../stages/deliver/feedLogic";

const SECTION_TITLE: Partial<Record<SourceOwner, string>> = {
  chapters: "Chapters",
  clips: "Clips",
};

/** Chapters and Clips sit on this page, so the listing scrolls to them; speakers and transcripts are edited in Edit. */
export function openFeedSource(owner: SourceOwner) {
  const title = SECTION_TITLE[owner];
  const heading =
    title === undefined
      ? undefined
      : [...document.querySelectorAll<HTMLElement>(".dv-section-title")].find(
          (el) => el.textContent === title,
        );
  const section = heading?.closest<HTMLElement>(".dv-section");
  if (!section) {
    runPointerCommand("stage.edit");
    return;
  }
  section.scrollIntoView({ block: "start" });
  section.querySelector<HTMLElement>("button, input")?.focus();
}
