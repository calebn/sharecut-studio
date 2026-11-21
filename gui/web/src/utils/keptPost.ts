import { randomUuid } from "./randomUuid";

/** What a guest post that could not reach the host yet answers with instead of a comment. */
export type KeptPost = { kept: true; id: string };

export function isKept(value: unknown): value is KeptPost {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kept?: unknown }).kept === true
  );
}

/** A fresh key for one comment or reply; the server derives its stored id from it. */
export function newPostKey(): string {
  return randomUuid().replaceAll("-", "");
}
