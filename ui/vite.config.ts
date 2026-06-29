import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname),
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
