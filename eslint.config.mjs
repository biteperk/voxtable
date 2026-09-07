// Flat ESLint config.
//
// `.mjs`, not `.js`: the root package.json has no `"type": "module"`, so Node
// re-parsed this file as CommonJS, failed, and re-parsed it as ESM — printing a
// MODULE_TYPELESS_PACKAGE_JSON warning and a performance note on every single
// lint run, including in CI. Adding `"type": "module"` at the root would have
// been the other fix, and would have changed how every plain `.js` file in the
// repo is loaded. The extension is the smaller change.
//
// Until now `.github/workflows/ci.yml` ran `npm run lint --if-present` with no
// `lint` script and no ESLint anywhere in the repo — so the step exited 0
// silently on every run and showed a green tick having executed nothing. The
// code even carried `eslint-disable` comments for rules nothing enforced.
//
// This config is deliberately RATCHETED rather than maximal. A strict first
// pass over ~30k lines of untouched JSX produces hundreds of findings with a
// poor bug-to-noise ratio, and a gate nobody can get green is a gate that gets
// bypassed. So: the rules that catch real defects are errors, the stylistic
// tail is off, and `npm run lint` must pass on the tree as it stands today.
// Tighten by promoting warnings, not by turning it all on at once.
//
// Note this replaces nothing for the frontend: the two Vite apps are plain
// JavaScript, so `tsc` cannot check them (it needs `checkJs`, which on this
// tree is mostly noise). ESLint is the only static analysis they have.

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import importX from "eslint-plugin-import-x";
import react from "eslint-plugin-react";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "node_modules/**",
      ".claude/**",
      "apps/backend/db/baseline-sydney/**",
      "public/**",
      "**/*.min.js"
    ]
  },

  js.configs.recommended,

  // ---- Backend: TypeScript, Node ------------------------------------------
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["apps/backend/**/*.ts"]
  })),
  {
    files: ["apps/backend/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2023, sourceType: "module" }
    },
    plugins: { "import-x": importX },
    rules: {
      // The class of error a frontend `tsc` would have caught, and the reason
      // eslint-plugin-import earns its place: a rename that misses one import
      // site fails at runtime, not at build time.
      "import-x/no-unresolved": "off", // TS resolves its own paths; tsc already gates this
      "import-x/no-duplicates": "error",

      // Unused code is the thing this repo asked to clean up. Errors, but
      // underscore-prefixed args stay legal so intentional signatures survive.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
          // `const { SECRET, ...rest } = env` is how you omit a key. The omitted
          // name is not dead code, it is the whole point of the expression.
          ignoreRestSiblings: true
        }
      ],

      // `any` is pervasive at the vendor boundaries (Stripe, Retell, Twilio
      // payloads) and Zod validates those anyway. Warn, don't block.
      "@typescript-eslint/no-explicit-any": "warn",

      // Real-bug rules.
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",
      "no-throw-literal": "error",

      // All logging goes through utils/logger.ts (structured JSON + PII
      // redaction). A bare console.* in the backend bypasses redaction, which
      // is how a phone number reaches stdout.
      "no-console": ["warn", { allow: ["warn", "error"] }]
    }
  },

  // Scripts and tests are allowed to talk to a human on stdout.
  {
    files: ["apps/backend/scripts/**/*.ts", "apps/backend/src/**/*.test.ts", "scripts/**/*.mjs"],
    rules: { "no-console": "off" }
  },

  // ---- Frontend + KDS: JavaScript, browser, React --------------------------
  {
    files: ["apps/frontend/**/*.{js,jsx}", "apps/kds/**/*.{js,jsx}"],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: "module",
        ecmaFeatures: { jsx: true }
      }
    },
    plugins: { react, "react-hooks": reactHooks, "import-x": importX },
    settings: { react: { version: "detect" } },
    rules: {
      // Without these two, every component referenced only from JSX reads as
      // an unused variable — 151 false positives on first run. They mark JSX
      // identifiers as used; nothing else from eslint-plugin-react is on.
      "react/jsx-uses-vars": "error",
      "react/jsx-uses-react": "error",

      // The rules that catch actual React defects: stale closures over state,
      // and hooks called conditionally.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",

      "import-x/no-duplicates": "error",

      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
          // `const { SECRET, ...rest } = env` is how you omit a key. The omitted
          // name is not dead code, it is the whole point of the expression.
          ignoreRestSiblings: true
        }
      ],
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",

      // The frontend forwards to Sentry; a stray console.log ships to a
      // customer's browser console.
      "no-console": ["warn", { allow: ["warn", "error"] }]
    }
  },

  // logger.test.ts imports "./logger" twice — once at the top, once mid-file
  // as a section divider. That is deliberate and load-bearing: .gitleaksignore
  // allowlists the fake JWT and Stripe token in that file BY LINE NUMBER
  // (jwt:38, stripe-access-token:66). Merging the imports shifts them six
  // lines, both fingerprints stop matching, and the secret scan re-arms on two
  // fixtures that exist purely to prove redaction works — turning a required
  // check red for no reason. I did exactly that once; this is the note so
  // nobody repeats it.
  //
  // The exemption lives here rather than as a comment in the file because ANY
  // line added above line 38 re-breaks the fingerprints, including the comment
  // explaining why. If those fixtures ever move, update .gitleaksignore in the
  // same commit.
  {
    files: ["apps/backend/src/utils/logger.test.ts"],
    rules: { "import-x/no-duplicates": "off" }
  },

  // Frontend tests run in node, not a browser.
  {
    files: ["apps/**/*.test.{js,jsx,ts}"],
    languageOptions: { globals: { ...globals.node } },
    rules: { "no-console": "off" }
  },

  // ---- Config files at the repo edges -------------------------------------
  {
    files: ["*.config.{js,cjs,mjs}", "**/*.config.{js,cjs,mjs}", "scripts/**/*.mjs"],
    languageOptions: { globals: { ...globals.node }, sourceType: "module" },
    rules: { "no-console": "off" }
  },
  // Loose Node helpers outside the workspaces (deploy/, one-shot scripts).
  {
    files: ["deploy/**/*.js", "deploy/**/*.mjs"],
    languageOptions: { globals: { ...globals.node }, sourceType: "module" },
    rules: { "no-console": "off", "no-unused-vars": ["error", { caughtErrors: "none" }] }
  },

  // Catch parameters that are deliberately ignored are not dead code.
  {
    files: ["**/*.{js,jsx,mjs,cjs}"],
    rules: {
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
          // `const { SECRET, ...rest } = env` is how you omit a key. The omitted
          // name is not dead code, it is the whole point of the expression.
          ignoreRestSiblings: true
        }
      ]
    }
  },

  // ---- The admin console's one structural rule ----------------------------
  //
  // A `disabled` button in the admin is the silent-bind bug. On 7 Sep 2026 an
  // operator believed they had bound a live venue's phone line; the button was
  // greyed out with a hover tooltip, no request ever left the browser, and
  // nothing anywhere said so — the venue sat unprovisioned while everyone
  // thought it was done.
  //
  // The fix was a rule: an admin control either acts, or it says why it cannot.
  // `components/admin/AdminAction.jsx` implements that (and is where the one
  // legitimate `disabled` lives — it blocks only a request already in flight,
  // which is not a refusal to explain). This makes the rule structural rather
  // than a convention someone has to remember, scoped to the pages so it cannot
  // creep back in a new panel.
  //
  // `error`, not `warn`, deliberately: `npm run lint` is `--max-warnings 27`, a
  // ratchet, so a new warning fails the build anyway but reports itself as
  // "too many warnings" rather than naming the problem.
  {
    files: ["apps/frontend/src/pages/admin/**/*.jsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: 'JSXAttribute[name.name="disabled"]',
          message:
            "Admin controls must never be silently disabled. Use <AdminAction blocked=\"why not\"> so the control explains itself on click — see components/admin/AdminAction.jsx."
        }
      ]
    }
  },

  {
    files: ["**/*.cjs"],
    languageOptions: { globals: { ...globals.node }, sourceType: "commonjs" }
  }
];
