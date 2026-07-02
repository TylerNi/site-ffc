import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import base from './index.js';

/**
 * Config ESLint partagée pour les packages React (web, admin, mobile).
 */
export default [
  ...base,
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
