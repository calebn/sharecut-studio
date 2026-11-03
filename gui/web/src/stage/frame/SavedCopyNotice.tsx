export function SavedCopyNotice() {
  return (
    <div className="guest-version guest-version--attention" role="status">
      <span className="guest-version-text">
        The host is offline. You are viewing a saved copy, so it is read-only.
      </span>
    </div>
  );
}
