import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" so the built site works on GitHub Pages at any repo path
export default defineConfig({
  plugins: [react()],
  base: "./",
});
