import { useEffect, useState } from "react";
import { SystemIcon } from "./SystemIcon";

/** How long the New version pill stays open before it folds into the version line. */
export const NEW_VERSION_PILL_MS = 10_000;

export type VersionLineProps = {
  /** The version this link plays. */
  label: string;
  /** True: the link plays whatever version is current (live glyph). False: pinned. Unknown (not read yet): no glyph. */
  followsLatest?: boolean;
  /** The host published while the guest was listening: the label of the new version. */
  update?: { id: string; label: string | null; onListen: () => void };
};

/**
 * The guest header's version line. A following link whose host published
 * shows an accent pill, "New version: X · Listen", for 10 s, then keeps the
 * line with a small accent dot until the guest listens.
 */
export function VersionLine({
  label,
  followsLatest,
  update,
}: VersionLineProps) {
  const [folded, setFolded] = useState<string | null>(null);
  const updateId = update?.id ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a different new version (by id) opens the pill again
  useEffect(() => {
    if (updateId === null) return;
    const id = window.setTimeout(
      () => setFolded(updateId),
      NEW_VERSION_PILL_MS,
    );
    return () => window.clearTimeout(id);
  }, [updateId]);

  const open = folded !== updateId;
  const named = update?.label ? `New version: ${update.label}` : "New version";
  return (
    <span className="sys-version">
      <span role="status" className="sr-only">
        {update && open ? `${named}. Listen` : ""}
      </span>
      {update ? (
        <button
          type="button"
          className={open ? "sys-version-pill" : "sys-version-line"}
          title={open ? undefined : `${named}. Listen`}
          aria-label={open ? undefined : `${label}. ${named}. Listen`}
          onClick={update.onListen}
        >
          {open ? (
            <>
              <SystemIcon name="refresh-cw" size={12} />
              <span className="sys-version-pill-text">{named}</span>
              <span className="sys-version-pill-action">
                <span aria-hidden="true">·</span>
                <span>Listen</span>
              </span>
            </>
          ) : (
            <>
              <VersionGlyph followsLatest={followsLatest} />
              <span className="sys-mono">{label}</span>
              <span className="sys-version-dot" aria-hidden="true" />
            </>
          )}
        </button>
      ) : (
        <span className="sys-version-line">
          <VersionGlyph followsLatest={followsLatest} />
          <span className="sys-mono">{label}</span>
        </span>
      )}
    </span>
  );
}

function VersionGlyph({ followsLatest }: { followsLatest?: boolean }) {
  if (followsLatest === undefined) return null;
  return (
    <span
      role="img"
      aria-label={
        followsLatest ? "Follows the latest version" : "Pinned to this version"
      }
      className="sys-version-glyph"
    >
      <SystemIcon name={followsLatest ? "refresh-cw" : "pin"} size={12} />
    </span>
  );
}
