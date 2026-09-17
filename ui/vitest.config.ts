import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname),
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: [resolve(__dirname, "src/test/setup.ts")],
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
  },
});
