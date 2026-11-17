import { createContext, useContext } from "react";

export const ShareNameContext = createContext<string | null>(null);

/**
 * The episode's name as the review link's own answer (or its saved copy) gave
 * it. It comes by context, not through the store, so the studio's first render
 * has it: the store is filled in an effect, after that render.
 */
export function useShareName(): string | null {
  return useContext(ShareNameContext);
}
