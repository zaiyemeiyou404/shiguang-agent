import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./app.css";
import { createPreviewBridge } from "./preview-bridge";

if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("preview") && !window.shiguang) {
  window.shiguang = createPreviewBridge();
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
