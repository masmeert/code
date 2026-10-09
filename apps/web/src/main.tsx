import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ready } from "./lib/store.ts";
import "./styles.css";

function renderApp() {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// Wait (briefly) for the cached threads so the first frame isn't an empty app.
void Promise.race([ready, new Promise((resolve) => setTimeout(resolve, 300))]).then(renderApp);
