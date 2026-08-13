import path from "path"
import { defineConfig } from "vitest/config"
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    }
  },
  test: {
    environment: "jsdom",
    setupFiles: "./vitest.setup.ts",
  },
})
