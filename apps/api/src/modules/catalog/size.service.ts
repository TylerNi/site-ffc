import { BadRequestException, Injectable } from '@nestjs/common';
import { type DimensionEquivalence, dimensionEquivalents, NOMINAL_FILTER_SIZES } from '@ffc/core';
import { PrismaService } from '../../database';
import { type SizeEquivalentsDto } from './dto/catalog-response.dto';

/**
 * Équivalences de tailles (tâche 06, point 3). Pour une dimension donnée,
 * retourne les tailles nominales compatibles (nominal ↔ réel, orientation
 * indifférente) à partir du référentiel `@ffc/core`, en indiquant lesquelles
 * sont réellement offertes au catalogue.
 *
 * Sert la recherche (résolution d'une dimension → ensemble de libellés) et un
 * endpoint public dédié (fiche taille de la vitrine, tâche 07).
 */
@Injectable()
export class SizeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Résout une saisie de dimension en équivalences, ou lève une 400 si elle
   * n'est pas analysable. Fonction pure `@ffc/core` — aucun accès base.
   */
  resolve(input: string): DimensionEquivalence {
    const result = dimensionEquivalents(input);
    if (!result) {
      throw new BadRequestException(
        `Dimension « ${input} » non reconnue. Exemples : 16x25x1, 16 x 25 x 1, 16-25-1.`,
      );
    }
    return result;
  }

  /** Libellés nominaux distincts réellement présents au catalogue (produits actifs). */
  async catalogLabels(): Promise<Set<string>> {
    const rows = await this.prisma.$queryRaw<Array<{ nominal_label: string }>>`
      SELECT DISTINCT v.nominal_label
      FROM product_variants v
      JOIN products p ON p.id = v.product_id AND p.status = 'ACTIVE'
      WHERE v.is_active = true`;
    return new Set(rows.map((row) => row.nominal_label));
  }

  /** Réponse d'équivalences enrichie de la présence au catalogue. */
  async equivalents(input: string): Promise<SizeEquivalentsDto> {
    const resolved = this.resolve(input);
    const catalog = await this.catalogLabels();

    // Les tailles du référentiel qui correspondent, plus leur présence catalogue.
    const equivalents = resolved.sizes.map((size) => ({
      label: size.nominal,
      nominal: size.nominalDimensions,
      actual: size.actualDimensions,
      inCatalog: catalog.has(size.nominal),
    }));

    return {
      input: resolved.input,
      canonical: resolved.canonical,
      catalogLabels: resolved.labels.filter((label) => catalog.has(label)),
      equivalents,
    };
  }

  /** Nombre de tailles nominales au référentiel (diagnostic/tests). */
  get referenceSizeCount(): number {
    return NOMINAL_FILTER_SIZES.length;
  }
}
