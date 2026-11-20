import type { SelectionModel } from "../../../edit/selectionFollow";
import type { ProjectView } from "../../../types/project";
import { scriptModelFor } from "./scriptHostModel";
import type { ScriptModel } from "./scriptModel";

const NO_SPANS: SelectionModel["spans"] = [];

/** The host has no held words, so a word with no timeline place counts as cut: it never waits. */
export function selectionModelOf(model: ScriptModel): SelectionModel {
  const count = model.refs.length;
  const times = Array.from({ length: count }, (_, at) => model.timeOf(at));
  const wordStarts = Array.from({ length: count }, (_, at) =>
    model.seekSecOf(at),
  );
  const texts: string[] = [];
  for (const turn of model.turns)
    for (const word of turn.words) texts[word.index] = word.text;
  return {
    turns: model.turns,
    spans: NO_SPANS,
    refs: model.refs,
    times,
    wordStarts,
    words: model.starts.map((start, at) => ({ start, text: texts[at] ?? "" })),
    cut: Array.from(
      { length: count },
      (_, at) => model.isCut(at) || wordStarts[at] === null,
    ),
  };
}

const byProject = new WeakMap<ProjectView, SelectionModel>();

export function selectionModelOfProject(project: ProjectView): SelectionModel {
  const known = byProject.get(project);
  if (known) return known;
  const built = selectionModelOf(scriptModelFor(project).model);
  byProject.set(project, built);
  return built;
}
