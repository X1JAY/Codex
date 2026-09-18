import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: {
      entry: "src/content/index.ts",
      name: "DouyinStudyAssistantContentScript",
      formats: ["iife"]
    },
    rollupOptions: {
      output: {
        entryFileNames: "content.js",
        inlineDynamicImports: true
      }
    }
  }
});
