import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import { LOCALES, type Locale } from '@ffc/core';

/** Valide le paramètre de route `:locale` (fr/en) — traductions produit/catégorie. */
@Injectable()
export class LocaleParamPipe implements PipeTransform<string, Locale> {
  transform(value: string): Locale {
    if (!LOCALES.includes(value as Locale)) {
      throw new BadRequestException(
        `Locale invalide : « ${value} » (attendu : ${LOCALES.join(', ')}).`,
      );
    }
    return value as Locale;
  }
}
