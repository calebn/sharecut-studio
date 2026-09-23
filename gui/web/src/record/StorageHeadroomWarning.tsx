import { useEffect } from "react";
import { useStorageHeadroom } from "./storageQuota";

/**
 * Advisory keeper storage warning. The `role="status"` live region stays
 * mounted and only its text changes, so screen readers announce a warning
 * that appears after the estimate resolves. When `recheck` turns true (for
 * example after a take stops and landed keepers are reclaimed) the estimate
 * runs again; overlapping estimates are ordered by `useStorageHeadroom`.
 */
export function StorageHeadroomWarning({
  visible = true,
  recheck = false,
}: {
  visible?: boolean;
  recheck?: boolean;
}) {
  const { message, refresh } = useStorageHeadroom();
  useEffect(() => {
    if (recheck) {
      void refresh();
    }
  }, [recheck, refresh]);
  const text = visible ? message : "";
  return (
    <p className={text ? "record-warn" : undefined} role="status">
      {text}
    </p>
  );
}
