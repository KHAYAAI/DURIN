import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'prisma/migrations/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Money must never touch floating point. Use @durin/ledger decimal helpers.
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.name='parseFloat']", message: 'Do not use parseFloat; use @durin/ledger decimal helpers.' },
        { selector: "MemberExpression[property.name='toFixed'] > CallExpression[callee.name='Number']", message: 'Do not format money via Number().toFixed.' },
      ],
    },
  },
  {
    files: ['test/**/*.ts', 'src/**/*.spec.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off', 'no-restricted-syntax': 'off' },
  },
);
