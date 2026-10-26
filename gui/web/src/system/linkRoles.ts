import type { SystemIconName } from "./icons";

export type LinkRole = "viewer" | "commenter" | "editor";

export const ROLES: readonly {
  id: LinkRole;
  label: string;
  icon: SystemIconName;
}[] = [
  { id: "viewer", label: "Viewer", icon: "ear" },
  { id: "commenter", label: "Commenter", icon: "message-square" },
  { id: "editor", label: "Editor", icon: "stage-edit" },
];
