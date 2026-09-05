// ESLint v9 flat config — ADR-0008
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import importX from "eslint-plugin-import-x";
import prettier from "eslint-config-prettier";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  // ── Ignores ──────────────────────────────────────────────────────────────────
  {
    // drizzle.config.ts is a root-level config file not included in tsconfig.json.
    ignores: [
      "dist/",
      "node_modules/",
      "drizzle/",
      "*.config.js",
      "drizzle.config.ts",
      ".claude/",
      "integrations/",
    ],
  },

  // ── Base JS ──────────────────────────────────────────────────────────────────
  js.configs.recommended,

  // ── TypeScript type-aware ─────────────────────────────────────────────────
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // ── Type-aware parser options (applies to all TS files) ──────────────────
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
  },

  // ── import-x rules ───────────────────────────────────────────────────────
  {
    plugins: {
      "import-x": importX,
    },
    rules: {
      // Enforce modular boundaries — no circular dependencies.
      "import-x/no-cycle": "error",
      // Enforce consistent import ordering.
      "import-x/order": [
        "warn",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "index", "type"],
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
    },
  },

  // ── Project-wide TypeScript rules ────────────────────────────────────────
  {
    rules: {
      // Always use `import type` for type-only imports.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      // Unhandled promise rejections are silent bugs.
      "@typescript-eslint/no-floating-promises": "error",
      // Async functions passed where sync is expected cause silent failures.
      "@typescript-eslint/no-misused-promises": "error",
      // Unused variables are almost always mistakes.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", args: "after-used" },
      ],
      // `any` weakens type safety — warn rather than error to allow escape hatches.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },

  // ── Test-file overrides ───────────────────────────────────────────────────
  {
    files: ["**/*.test.ts"],
    rules: {
      // Tests frequently need escape hatches; keep correctness rules on.
      "@typescript-eslint/no-explicit-any": "off",
      // Type assertions in tests are idiomatic.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      // Node built-in test runner: describe()/it() return Promise<void> but the
      // framework handles them; requiring void/await on every call is noisy.
      "@typescript-eslint/no-floating-promises": "off",
      // Mock/stub async methods in test doubles never need await.
      "@typescript-eslint/require-await": "off",
    },
  },

  // ── Mastra bindings overrides ─────────────────────────────────────────────
  // eslint-plugin-import-x@4.17.1 crashes with "node with invalid interface"
  // when tracing @mastra/core deep subpath exports (e.g. @mastra/core/mastra).
  // The Mastra workflow/run/tool APIs are dynamically typed (`any`); suppress
  // the unsafe-* family and require-await for these files only.
  // src/evals/run.ts also imports @mastra/core/mastra (eval runner), so it
  // gets the same no-cycle suppression.
  {
    files: ["src/bindings/mastra/**", "src/evals/run.ts"],
    rules: {
      "import-x/no-cycle": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/require-await": "off",
    },
  },

  // ── Prettier LAST — disables all formatting-conflicting rules ────────────
  prettier
);
