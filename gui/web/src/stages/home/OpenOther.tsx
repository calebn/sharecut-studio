import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Button, InlineError } from "../../ui";

export type OpenOtherProps = {
  /** `picker`: the OS folder picker exists. `path`: a plain browser, so a path field. */
  mode: "picker" | "path";
  path: string;
  /** Plain words with a fix; never the server's text. */
  error?: string;
  /** Starts with the path popover showing (stories, and a retry after an error). */
  defaultOpen?: boolean;
  onChooseFolder: () => void;
  onPathChange: (path: string) => void;
  onSubmit: () => void;
  onClose?: () => void;
};

/** The error copy for a folder with no episode in it. */
export const NOT_AN_EPISODE =
  "That folder has no ShareCut episode. Choose the folder that holds episode.project.json.";

/**
 * "Open other…": the OS folder picker where there is one, otherwise a popover
 * under the button with one path field. Enter submits; the error sits under
 * the field.
 */
export function OpenOther({
  mode,
  path,
  error,
  defaultOpen = false,
  onChooseFolder,
  onPathChange,
  onSubmit,
  onClose,
}: OpenOtherProps) {
  const [open, setOpen] = useState(defaultOpen);
  const errorId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const wasPicker = useRef(mode === "picker");
  useEffect(() => {
    if (mode === "path" && wasPicker.current) setOpen(true);
    wasPicker.current = mode === "picker";
  }, [mode]);
  const showing = mode === "path" && open;
  useEffect(() => {
    if (showing) field.current?.focus();
  }, [showing]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };
  const toggle = () => {
    if (open) onClose?.();
    setOpen(!open);
  };
  const closeOnEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    setOpen(false);
    onClose?.();
    trigger.current?.focus();
  };
  return (
    <div className="sys-open-other">
      <button
        ref={trigger}
        type="button"
        className="sys-text-btn"
        aria-expanded={mode === "path" ? open : undefined}
        onClick={mode === "picker" ? onChooseFolder : toggle}
      >
        Open other…
      </button>
      {showing ? (
        <form
          className="sys-open-pop"
          aria-label="Open another episode"
          onSubmit={submit}
        >
          <div className="sys-open-row">
            <input
              ref={field}
              type="text"
              className="sys-open-field"
              aria-label="Folder of the episode"
              placeholder="Folder of the episode"
              autoComplete="off"
              value={path}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(event) => onPathChange(event.target.value)}
              onKeyDown={closeOnEscape}
            />
            <Button type="submit" variant="primary" onKeyDown={closeOnEscape}>
              Open
            </Button>
          </div>
          <InlineError id={errorId} message={error} />
        </form>
      ) : null}
    </div>
  );
}
