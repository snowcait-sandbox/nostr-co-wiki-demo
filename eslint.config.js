import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier/flat";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import ts from "typescript-eslint";

export default defineConfig(
  globalIgnores([
    "**/node_modules/**",
    "**/.svelte-kit/**",
    "**/.wrangler/**",
    "**/worker-configuration.d.ts",
  ]),
  js.configs.recommended,
  {
    files: ["**/*.{ts,svelte}"],
    extends: [ts.configs.recommended],
  },
  svelte.configs.recommended,
  svelte.configs.prettier,
  prettier,
  {
    files: ["**/*.js"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["**/*.svelte"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { parser: ts.parser },
    },
  },
  {
    rules: { curly: ["error", "all"] },
  },
);
