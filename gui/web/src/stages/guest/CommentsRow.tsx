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
  /** What that count counts, for the name: "comments · 2 suggestions". */
  afterCount: string;
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
  afterCount,
  preview,
  flash,
  onOpen,
}: CommentsRowProps) {
  const replacesLabel = flash ?? preview;
  // No aria-label: the name is the button's content, so it always holds the
  // visible text. The hidden words add what the button does ("Show") and, while
  // the row shows something else, what the visible count counts.
  return (
    <button type="button" className="gl-row" onClick={onOpen}>
      <SystemIcon name="message-square" size={16} />
      <span className="sr-only">Show</span>{" "}
      {replacesLabel ? (
        <>
          <span className="gl-row-count">{comments}</span>{" "}
          <span className="sr-only">{afterCount}</span>{" "}
        </>
      ) : null}
      {flash ? (
        <span className="gl-row-text">{flash}</span>
      ) : preview ? (
        <span className="gl-row-text">
          <span className="gl-row-who">
            {preview.author} · {preview.time}
          </span>{" "}
          <span dir="auto">{preview.text}</span>
        </span>
      ) : (
        <span className="gl-row-text">{label}</span>
      )}
      <SystemIcon name="chevron-up" size={16} />
    </button>
  );
}
