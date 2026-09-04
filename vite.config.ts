import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    printWidth: 80,
    ignorePatterns: ["pnpm-lock.yaml", "dist/**", "node_modules/**"],
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      complexity: ["warn", { max: 20 }],
      "max-lines": ["warn", { max: 500 }],
      "max-lines-per-function": ["warn", { max: 100 }],
      "typescript/no-floating-promises": "error",
      "typescript/no-misused-promises": "error",
      "typescript/switch-exhaustiveness-check": "error",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    include: ["{apps,packages}/**/test/**/*.test.{ts,tsx}"],
    fileParallelism: false,
  },
});
