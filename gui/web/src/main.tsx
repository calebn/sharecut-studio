import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { captureBootProjectFile } from "./desktop/openProjectFile";
import { initTheme } from "./hooks/useTheme";
import { readBootName } from "./state/bootName";

initTheme();
captureBootProjectFile();

// Read before the first render replaces what the server wrote there.
const root = document.getElementById("root")!;
const bootName = readBootName(root);

createRoot(root).render(
  <StrictMode>
    <App bootName={bootName} />
  </StrictMode>,
);
