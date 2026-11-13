import { SystemIcon } from "../../system/SystemIcon";

export type CommentsRowPreview = {
  author: string;
  time: string;
  text: string;
};

type CommentsRowProps = {
  /** "15 comments", "15 comments · 2 suggestions". */
  label: string;
  /** The count the accessible name carries beside a preview. */
  comments: number;
  /** The comment the guest is listening past; the row shows it in place of the label. */
  preview?: CommentsRowPreview;
  /** "Comment added at 1:26", shown for a moment after a post. */
  flash?: string;
  onOpen: () => void;
};

/** The 3 rem row above the dock: the comment count, one tap from the Comments sheet. */
export function CommentsRow({
  label,
  comments,
  preview,
  flash,
  onOpen,
}: CommentsRowProps) {
  const shown = flash
    ? flash
    : preview
      ? `${preview.author} · ${preview.time} ${preview.text}, ${comments}`
      : label;
  return (
    <>
      <button
        type="button"
        className="gl-row"
        aria-label={`Show comments, ${shown}`}
        onClick={onOpen}
      >
        <SystemIcon name="message-square" size={16} />
        {flash ? (
          <span className="gl-row-text">{flash}</span>
        ) : preview ? (
          <span className="gl-row-text">
            <span className="gl-row-who">
              {preview.author} · {preview.time}
            </span>{" "}
            {preview.text}
          </span>
        ) : (
          <span className="gl-row-text">{label}</span>
        )}
        {preview ? <span className="gl-row-count">{comments}</span> : null}
        <SystemIcon name="chevron-up" size={16} />
      </button>
      <span className="sr-only" aria-live="polite">
        {flash}
      </span>
    </>
  );
}
