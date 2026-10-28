import { Cover, type CoverProps } from "../system/Cover";

/**
 * Owns `<main>`; the Cover is its one section. `status` says how the last
 * save or recovery went, in a polite status line under the Cover's text.
 */
export function GuestCovers({
  cover,
  status,
}: {
  cover: CoverProps;
  status?: string | null;
}) {
  return (
    <main>
      <Cover
        {...cover}
        extra={
          status ? (
            <p className="sys-cover-text" role="status">
              {status}
            </p>
          ) : undefined
        }
      />
    </main>
  );
}
