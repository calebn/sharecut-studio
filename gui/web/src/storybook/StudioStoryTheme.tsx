import { type PropsWithChildren, useLayoutEffect } from "react";
import {
  applyTheme,
  isThemePreference,
  type ThemePreference,
} from "../hooks/useTheme";
import { docsStoryParentRoot } from "./docsThemeGlobal";

export function StudioStoryTheme({
  preference,
  children,
}: PropsWithChildren<{ preference: ThemePreference }>) {
  useLayoutEffect(() => {
    const parentRoot = docsStoryParentRoot();
    if (!parentRoot) {
      applyTheme(preference);
      return;
    }

    const synchronize = () => {
      const parentPreference = parentRoot.dataset.theme;
      applyTheme(
        isThemePreference(parentPreference) ? parentPreference : "system",
      );
    };
    synchronize();
    const observer = new MutationObserver(synchronize);
    observer.observe(parentRoot, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, [preference]);

  return children;
}
