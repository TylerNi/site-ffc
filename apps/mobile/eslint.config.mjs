import react from '@ffc/eslint-config/react';

export default [
  ...react,
  {
    ignores: ['expo-env.d.ts', '.expo/**'],
  },
];
