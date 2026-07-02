import react from '@ffc/eslint-config/react';

export default [
  ...react,
  {
    ignores: ['next-env.d.ts', '.next/**'],
  },
];
