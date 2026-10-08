import { createContext, useContext } from "react";
import type { HitRouter } from "./hitRouting";

const HitRouterContext = createContext<HitRouter | null>(null);

/** The timeline's one hit router, for a part of the timeline mounted outside its root. */
export const HitRouterProvider = HitRouterContext.Provider;

/** The enclosing timeline's router; null outside a `HitRouterProvider`. */
export function useHitRouter(): HitRouter | null {
  return useContext(HitRouterContext);
}
