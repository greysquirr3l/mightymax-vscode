import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      '**/*.cjs',
      '.vscode-test.mjs',
      '.vscode-test/**',
      'esbuild.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'error',
      'no-console': ['warn', { allow: ['error'] }],
      // Domain layer is framework-free; tests live next to source but are
      // excluded from the production bundle by esbuild externals.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },
  {
    // Test files: relax a few rules where the strictness hurts more than helps
    // in test scaffolding (mocha globals, async cleanup, etc).
    files: ['src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Mocha test bodies are legitimately async-or-sync; require-await
      // is overzealous for the async test() callbacks that don't await.
      '@typescript-eslint/require-await': 'off',
      // The `vscode.Extension.packageJSON` field is typed as `any` in
      // @types/vscode; reading `contributes` / `engines` / `capabilities`
      // is the whole point of the manifest contract test below.
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      // `describe` / `it` from `node:test` are async (`Promise<void>`)
      // and the test runner awaits them internally; floating-promises
      // over-fires in this exact pattern.
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
);
