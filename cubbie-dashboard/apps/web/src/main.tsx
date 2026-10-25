import React from "react";
import { createRoot } from "react-dom/client";
import { loadRuntimeConfig } from "./config";
import "./styles.css";

// Config must load before the API and auth modules read it, so they are imported afterwards.
(async () => {
  await loadRuntimeConfig();
  const { completeSignIn } = await import("./auth/cognito");
  try { await completeSignIn(); } catch (err) { console.error(err); }
  const { default: App } = await import("./App");
  createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
})();
