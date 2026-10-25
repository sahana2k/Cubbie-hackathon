import React from "react";
import { createRoot } from "react-dom/client";
import { loadRuntimeConfig } from "./config";
import "./styles.css";

// Load local configuration before importing the dashboard.
(async () => {
  await loadRuntimeConfig();
  const { default: App } = await import("./App");
  createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
})();
