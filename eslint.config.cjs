import js from '@eslint/js'
import typescript from '@typescript-eslint/eslint-plugin'
import typescriptParser from '@typescript-eslint/parser'
import prettier from 'eslint-plugin-prettier'
import prettierConfig from 'eslint-config-prettier'
import globals from 'globals'

export default [
  js.configs.recommended,
  {
    files: ['**/*.{js,ts}'],
    languageOptions: {
      parser: typescriptParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': typescript,
      prettier: prettier,
    },
    rules: {
      // Inherit TypeScript recommended rules
      ...typescript.configs.recommended.rules,
      ...prettierConfig.rules,
      
      // Prettier enforcement
      'prettier/prettier': 'error',
      
      // TypeScript rules (same as dev repo)
      '@typescript-eslint/no-unused-vars': ['error', { 
        argsIgnorePattern: '^(event|context|_)$' 
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      
      // Code quality rules (same as dev repo)
      'consistent-return': 'error',
      'prefer-const': 'error',
      'no-debugger': 'warn',
      'no-fallthrough': 'error',
      'curly': 'error',
      'eqeqeq': 'error',
      'no-const-assign': 'error',
      'no-multiple-empty-lines': 'error',
      'no-var': 'error',
      'no-duplicate-imports': 'error',
      'complexity': ['error', { max: 30 }],
      
      // Lambda-specific overrides
      'no-console': 'off',  // CloudWatch needs console.log
      'no-alert': 'off',    // Not applicable to Lambda
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
]
