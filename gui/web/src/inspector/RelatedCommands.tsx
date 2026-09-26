import { commandById } from "../commands/catalog";
import { buildCommandContext } from "../commands/context";
import { canApplyPass12, canIngestMedia } from "../shareMode";
import { useDaw } from "../state/useDaw";
import type { Selection } from "../types/project";
import { CommandButton, EmptyState } from "../ui";
import {
  moreCommandsFor,
  relatedCommandsFor,
} from "./relatedCommandDescriptors";

type Props = {
  selection: Selection | null;
};

/**
 * "You might also want…" zone for the mobile selection sheet.
 * Shows related commands for the current selection, making them
 * discoverable in context.
 */
export function RelatedCommands({ selection }: Props) {
  const { liveSelection, project, canCut, canReorder } = useDaw((state) => ({
    liveSelection: state.selection,
    project: state.project,
    canCut: canApplyPass12(
      state.projectPath,
      state.guestMode,
      state.shareCapabilities,
    ),
    canReorder: canIngestMedia(
      state.projectPath,
      state.guestMode,
      state.shareCapabilities,
    ),
  }));
  const related = relatedCommandsFor(selection);
  // Permission subscriptions keep the list current after role changes.
  // The command bus rechecks at click time.
  const more = moreCommandsFor(selection, liveSelection, project, {
    ...buildCommandContext(),
    canApplyPass12: canCut,
    canIngestMedia: canReorder,
  });

  if (selection == null) {
    return null;
  }

  return (
    <section className="related-commands" aria-label="Selection actions">
      {related.length > 0 ? (
        <div className="related-commands-zone" aria-label="Related commands">
          <h3 className="related-commands-heading">You might also want…</h3>
          <div className="related-commands-list">
            {related.map((descriptor) => {
              const cmd = commandById(descriptor.commandId);
              if (!cmd) {
                return null;
              }
              return (
                <CommandButton
                  key={descriptor.commandId}
                  commandId={descriptor.commandId}
                  args={descriptor.args}
                  respectWhen={descriptor.respectWhen}
                >
                  {cmd.label}
                </CommandButton>
              );
            })}
          </div>
        </div>
      ) : null}
      <div className="related-commands-zone" aria-label="More actions">
        <h3 className="related-commands-heading">More</h3>
        {more.length === 0 ? (
          <EmptyState>No additional actions for this selection.</EmptyState>
        ) : (
          <div className="related-commands-list">
            {more.map((descriptor) => {
              const cmd = commandById(descriptor.commandId);
              if (!cmd) {
                return null;
              }
              return (
                <CommandButton
                  key={descriptor.commandId}
                  commandId={descriptor.commandId}
                  args={descriptor.args}
                  respectWhen={descriptor.respectWhen}
                >
                  {cmd.label}
                </CommandButton>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
