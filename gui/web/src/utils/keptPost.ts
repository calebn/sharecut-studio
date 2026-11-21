import { randomUuid } from "./randomUuid";

export type KeptPost = { kept: true; id: string };

export function isKept(value: unknown): value is KeptPost {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kept?: unknown }).kept === true
  );
}

export function newPostKey(): string {
  return randomUuid().replaceAll("-", "");
}
