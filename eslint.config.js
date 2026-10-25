const { defineConfig } = require('eslint/config');
const js = require('@eslint/js');
const globals = require('globals');
const tseslint = require('typescript-eslint');

// Só regras de correção: formatação é responsabilidade do Prettier.
module.exports = defineConfig(
  { ignores: ['dist/', 'coverage/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // Configs e scripts de build: rodam direto no Node, sem passar pelo tsc.
    files: ['**/*.{js,cjs,mjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{js,cjs}'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
