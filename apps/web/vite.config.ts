import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    proxy: {
      // session API -> controller
      "/api": "http://127.0.0.1:4600",
      // direct mode (`pnpm dev`): socket straight to a local worker
      "/ws": { target: "ws://127.0.0.1:8080", ws: true },
      "/health": "http://127.0.0.1:8080",
    },
  },
});
