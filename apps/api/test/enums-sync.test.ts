import { LOCALES, PRISMA_ENUMS } from '@ffc/core';
import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

/**
 * Garantit que les enums du schéma Prisma restent le miroir exact des
 * constantes de @ffc/core (packages/core/src/enums.ts) : même liste d'enums,
 * mêmes valeurs, dans le même ordre.
 */
describe('synchronisation des enums core ↔ Prisma', () => {
  const registry: Record<string, readonly string[]> = {
    ...PRISMA_ENUMS,
    Locale: LOCALES,
  };
  const prismaEnums = new Map(
    Prisma.dmmf.datamodel.enums.map((e) => [e.name, e.values.map((v) => v.name)]),
  );

  it('chaque enum Prisma existe dans @ffc/core avec les mêmes valeurs', () => {
    for (const [name, values] of prismaEnums) {
      const expected = registry[name];
      expect(expected, `enum Prisma « ${name} » absente de @ffc/core`).toBeDefined();
      expect(values, `valeurs divergentes pour « ${name} »`).toEqual([...(expected ?? [])]);
    }
  });

  it('chaque enum de @ffc/core existe dans le schéma Prisma', () => {
    for (const name of Object.keys(registry)) {
      expect(prismaEnums.has(name), `enum core « ${name} » absente du schéma Prisma`).toBe(true);
    }
  });
});
