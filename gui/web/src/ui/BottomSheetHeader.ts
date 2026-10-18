import { createContext, useContext } from "react";

type SheetHeaderHosts = {
  title: HTMLElement | null;
  actions: HTMLElement | null;
  root: HTMLElement | null;
  shortPhone: boolean;
};
export const SheetHeaderContext = createContext<SheetHeaderHosts | null>(null);

export function useSheetHeader() {
  return useContext(SheetHeaderContext);
}
