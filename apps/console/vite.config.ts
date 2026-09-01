import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/rpc": process.env.FACTORY_SERVICE_URL ?? "http://127.0.0.1:4317",
    },
  },
});
