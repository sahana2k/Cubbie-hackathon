import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { fileURLToPath } from "node:url";

// "preview" mode builds one self-contained index.html (demo data, no backend) for sharing as a link.
// Normal builds are served by the local Python dashboard.
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === "preview" ? [viteSingleFile()] : [])],
  resolve: {
    alias: { "@cubbie/shared": fileURLToPath(new URL("../../packages/shared/src", import.meta.url)) }
  },
  build: { outDir: mode === "preview" ? "dist-preview" : "dist", sourcemap: mode !== "preview" }
}));
