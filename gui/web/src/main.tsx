import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { initTabsHeight } from "./hooks/useTabsHeight";
import { initTheme } from "./hooks/useTheme";
import { applyLabQuery } from "./utils/labFlags";

initTheme();
initTabsHeight();
applyLabQuery(window.location.search);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
