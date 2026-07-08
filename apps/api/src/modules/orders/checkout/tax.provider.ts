import { CanadianTaxCalculator, type TaxCalculator } from '@ffc/core';

/**
 * Jeton d'injection du calculateur de taxes.
 *
 * Le checkout ne connaît que l'interface `TaxCalculator` (@ffc/core) :
 * brancher Stripe Tax plus tard (point ouvert n° 6 du plan) = fournir une
 * autre implémentation ici, sans toucher au reste du checkout.
 */
export const TAX_CALCULATOR = Symbol('TAX_CALCULATOR');

export const taxCalculatorProvider = {
  provide: TAX_CALCULATOR,
  useValue: new CanadianTaxCalculator() satisfies TaxCalculator,
};
