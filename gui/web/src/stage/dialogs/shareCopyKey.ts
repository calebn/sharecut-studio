/**
 * The `copiedKey` shape shared between `ShareDialogView` (paint) and
 * `ShareDialog` (the adapter that sets it after a clipboard write). Kept in
 * its own module, not `ShareDialogView.tsx`, so the view file exports only
 * types and the component (react/only-export-components / Fast Refresh).
 */
export type ShareCopyKind = "link" | "mcp";
export type ShareCopiedKey = `${ShareCopyKind}:${string}`;

export function shareCopyKey(
  kind: ShareCopyKind,
  token: string,
): ShareCopiedKey {
  return `${kind}:${token}`;
}
