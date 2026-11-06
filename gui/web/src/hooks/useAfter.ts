import { useEffect, useState } from "react";

/** False until `ms` have passed since mount; null never fires. */
export function useAfter(ms: number | null): boolean {
  const [passed, setPassed] = useState(false);
  useEffect(() => {
    if (ms === null) return;
    const timer = window.setTimeout(() => setPassed(true), ms);
    return () => window.clearTimeout(timer);
  }, [ms]);
  return passed;
}
