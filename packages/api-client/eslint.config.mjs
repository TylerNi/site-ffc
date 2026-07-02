import base from '@ffc/eslint-config';

export default [
  ...base,
  {
    // Code généré depuis l'OpenAPI — ne pas linter.
    ignores: ['src/generated/**'],
  },
];
