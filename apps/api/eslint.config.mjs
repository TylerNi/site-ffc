import base from '@ffc/eslint-config';

export default [
  ...base,
  {
    // NestJS émet les types dans les métadonnées de décorateurs
    // (design:paramtypes) : l'injection de dépendances et ValidationPipe
    // exigent que ces classes restent des imports de VALEUR. Ces options
    // font que consistent-type-imports ne convertit pas les imports
    // référencés dans un contexte décoré.
    languageOptions: {
      parserOptions: {
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
      },
    },
  },
];
