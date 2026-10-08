// SPDX-License-Identifier: MIT
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "plans/**",
      "**/worker-configuration.d.ts",
      ".quaso/**",
      "**/.wrangler/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
          ignoreRestSiblings: true,
        },
      ],
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-control-regex": "off",
      eqeqeq: "error",
      "no-eval": "error",
      "preserve-caught-error": "off",
      "no-useless-assignment": "off",
    },
  },
  { files: ["**/*.test.ts"], rules: { "no-loss-of-precision": "off" } },
  {
    files: [
      "packages/design-system/src/**/*.{ts,tsx}",
      "packages/web/src/**/*.{ts,tsx}",
      "site/src/**/*.{ts,tsx}",
    ],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/set-state-in-effect": "error",
      "react-hooks/set-state-in-render": "error",
    },
  },
  {
    files: [
      "packages/design-system/src/**/*.tsx",
      "packages/web/src/**/*.tsx",
      "site/src/**/*.tsx",
    ],
    ignores: [
      "packages/design-system/src/components/Controls.tsx",
      "packages/design-system/src/components/Button.tsx",
      "packages/design-system/src/components/TextArea.tsx",
      "packages/design-system/src/components/Typography.tsx",
      "packages/design-system/src/components/Dialog.tsx",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "JSXOpeningElement[name.type='JSXIdentifier'][name.name=/^(button|input|select|textarea|a|label|fieldset|table|progress|details|summary|dialog|h[1-4]|kbd)$/]",
          message:
            "Use a shared component from @quaso/design-system so the app, website, and catalog stay in sync.",
        },
      ],
    },
  },
  {
    files: ["packages/design-system/src/**/*.{ts,tsx}"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?:@quaso/|(?:\\.\\.?/).*(?:web|core|service|server|cli|cloudflare|site)/)",
              message:
                "The design system must be independent of consumers and application domain code.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/web/**/*.{ts,tsx}", "site/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(?:^@quaso/design-system/src/|(?:^|/)design-system/(?:src|public)/)",
              message: "Import the design system through its public package exports.",
            },
            {
              regex: "(?:^@quaso/web/|(?:^|/)packages/web/)",
              message:
                "The website must use @quaso/design-system instead of application implementation files.",
            },
          ],
        },
      ],
    },
  },
);
