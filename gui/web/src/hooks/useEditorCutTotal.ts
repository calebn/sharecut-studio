import { createContext, useContext } from "react";

export const EditorCutTotal = createContext<number | null | undefined>(
  undefined,
);

export function useEditorCutTotal() {
  return useContext(EditorCutTotal);
}

export function useCutTotal(projectSeconds: number | undefined): number | null {
  const seconds = useEditorCutTotal();
  return seconds === undefined ? (projectSeconds ?? null) : seconds;
}
