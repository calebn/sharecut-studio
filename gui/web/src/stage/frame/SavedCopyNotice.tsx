export function SavedCopyNotice() {
  return (
    <div className="guest-version guest-version--attention" role="status">
      <span className="guest-version-text">
        Showing a saved copy because the host can't be reached. It is read-only.
      </span>
    </div>
  );
}
