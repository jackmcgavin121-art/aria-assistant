import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./", // relative asset paths so file:// loading works in the packaged app
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist-renderer",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
