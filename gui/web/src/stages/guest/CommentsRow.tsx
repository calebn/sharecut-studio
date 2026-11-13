import { SystemIcon } from "../../system/SystemIcon";

export type CommentsRowPreview = {
  author: string;
  time: string;
  text: string;
};

type CommentsRowProps = {
  /** "15 comments", "15 comments · 2 suggestions". */
  label: string;
  /** The count that sits beside the icon while the row shows something else. */
  comments: number;
  /** The comment the guest is listening past; the row shows it in place of the label. */
  preview?: CommentsRowPreview;
  /** "Comment added at 1:26", shown for a moment after a post. */
  flash?: string;
  onOpen: () => void;
};

/** The 3 rem row above the dock: the comment count, one tap from the Comments list. */
export function CommentsRow({
  label,
  comments,
  preview,
  flash,
  onOpen,
}: CommentsRowProps) {
  const shown = flash ?? preview;
  return (
    <button
      type="button"
      className="gl-row"
      aria-label={`Show ${label}`}
      onClick={onOpen}
    >
      <SystemIcon name="message-square" size={16} />
      {shown ? <span className="gl-row-count">{comments}</span> : null}
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
      <SystemIcon name="chevron-up" size={16} />
    </button>
  );
}
