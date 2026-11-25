import { createContext, useContext } from "react";

export const MenuCloseContext = createContext<() => void>(() => {});

/**
 * Closes the nearest menu. For rows a shared component puts inside menus it
 * does not own, such as the People rows in the Project and Stage menus.
 */
export function useMenuClose(): () => void {
  return useContext(MenuCloseContext);
}
