import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    printWidth: 80,
    ignorePatterns: [
      "pnpm-lock.yaml",
      "dist/**",
      "node_modules/**",
      "prototypes/codex-app-server-probe/fixture/acceptance/**",
    ],
  },
  lint: {
    ignorePatterns: ["prototypes/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    include: ["{apps,packages}/**/test/**/*.test.ts"],
    fileParallelism: false,
  },
});
