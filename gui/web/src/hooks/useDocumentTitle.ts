import { useEffect } from "react";

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
