import { commandById } from "../commands/catalog";
import type { Selection } from "../types/project";
import { CommandButton } from "../ui";
import { relatedCommandsFor } from "./relatedCommands";

type Props = {
  selection: Selection | null;
};

/**
 * "You might also want…" zone for the mobile selection sheet.
 * Shows related commands for the current selection, making them
 * discoverable in context.
 */
export function RelatedCommands({ selection }: Props) {
  const commandIds = relatedCommandsFor(selection);

  if (commandIds.length === 0) {
    return null;
  }

  return (
    <section className="related-commands" aria-label="Related commands">
      <h3 className="related-commands-heading">You might also want…</h3>
      <div className="related-commands-list">
        {commandIds.map((id) => {
          const cmd = commandById(id);
          if (!cmd) {
            return null;
          }
          return (
            <CommandButton key={id} commandId={id}>
              {cmd.label}
            </CommandButton>
          );
        })}
      </div>
    </section>
  );
}
