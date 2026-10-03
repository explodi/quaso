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
    files: ["packages/web/src/**/*.{ts,tsx}", "site/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/set-state-in-effect": "error",
      "react-hooks/set-state-in-render": "error",
    },
  },
  {
    files: ["packages/web/src/**/*.tsx", "site/src/**/*.tsx"],
    ignores: [
      "packages/web/src/components/Controls.tsx",
      "packages/web/src/components/Button.tsx",
      "packages/web/src/components/TextArea.tsx",
      "packages/web/src/components/Typography.tsx",
      "packages/web/src/components/Dialog.tsx",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "JSXOpeningElement[name.type='JSXIdentifier'][name.name=/^(button|input|select|textarea|a|label|fieldset|table|progress|details|summary|dialog|h[1-4]|kbd)$/]",
          message:
            "Use the shared Quaso component from design-system.ts so the catalog and app stay in sync.",
        },
      ],
    },
  },
);
