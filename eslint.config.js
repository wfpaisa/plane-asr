// ESLint flat config for the Plane ASR GNOME Shell extension.
//
// Follows the GJS style guide:
//   https://gjs.guide/extensions/development/creating.html#es-lint
//
// GNOME Shell exposes one additional global variable called `global`.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['**/*.ts', '**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                // GJS / GNOME Shell globals
                global: 'readonly',
                imports: 'readonly',
                print: 'readonly',
                log: 'readonly',
                logError: 'readonly',
            },
        },
        rules: {
            // Style is enforced by Prettier; ESLint focuses on correctness.
            'prefer-const': 'error',
            'no-var': 'error',
            eqeqeq: 'error',
            '@typescript-eslint/no-unused-vars': 'warn',
            'no-unused-vars': 'off',
        },
    },
    {
        ignores: ['dist/**', 'node_modules/**', '*.zip'],
    },
];
