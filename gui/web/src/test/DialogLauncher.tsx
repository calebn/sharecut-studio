import { type ReactNode, useState } from "react";
import { Button } from "../ui/Button";

/**
 * Story preview for a dialog: a launcher button plus the open state the
 * dialog's app owner would hold. `children` renders the dialog from `open`
 * and a `close` callback that the story wraps into its close handoffs.
 */
export function DialogLauncher({
  label,
  initiallyOpen,
  children,
}: {
  label: string;
  initiallyOpen: boolean;
  children: (open: boolean, close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        {label}
      </Button>
      {children(open, () => setOpen(false))}
    </>
  );
}
