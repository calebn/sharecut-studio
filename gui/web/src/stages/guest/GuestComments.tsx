import { CommentCard, type CommentCardData } from "../../system/CommentCard";

/** A comment as the guest sees it. `status` is absent once the server has it. */
export type GuestComment = {
  comment: CommentCardData;
  status?: "queued" | "failed";
};

type Props = {
  comments: readonly GuestComment[];
  onSeek: (seconds: number) => void;
  onRetry?: (id: string) => void;
  onRemove?: (id: string) => void;
};

/** Read-only: a guest cannot resolve, tick actions or reply here. */
export function GuestComments({ comments, onSeek, onRetry, onRemove }: Props) {
  if (comments.length === 0) return null;
  return (
    <section className="gr-comments" aria-label="Comments">
      {comments.map(({ comment, status }) => {
        const at = comment.at;
        return (
          <CommentCard
            key={comment.id}
            comment={comment}
            pending={
              status === "failed"
                ? {
                    state: "failed",
                    onRetry: () => onRetry?.(comment.id),
                    onRemove: () => onRemove?.(comment.id),
                  }
                : status === "queued"
                  ? { state: "queued" }
                  : undefined
            }
            onSelect={at ? () => onSeek(at.start) : undefined}
          />
        );
      })}
    </section>
  );
}
