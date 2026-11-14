import { useEffect } from "react";

/** Sets document.title while mounted and while `title` is non-null; restores the title it replaced. */
export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    if (title === null) {
      return;
    }
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
