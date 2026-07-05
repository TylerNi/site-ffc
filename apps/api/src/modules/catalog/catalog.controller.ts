import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
import { CatalogService } from './catalog.service';
import { CACHE_CONTROL } from './catalog.util';
import {
  CatalogFilterQueryDto,
  LocaleQueryDto,
  SearchQueryDto,
  SuggestQueryDto,
} from './dto/catalog-query.dto';
import {
  CategoryTreeDto,
  ProductDetailDto,
  ProductListDto,
  SizeEquivalentsDto,
  SizeIndexDto,
  SuggestDto,
} from './dto/catalog-response.dto';
import { SearchService } from './search.service';
import { SizeService } from './size.service';

/**
 * Catalogue public (tâche 06). Toutes les routes sont @Public() et posent des
 * en-têtes de cache publics — les pages ISR de la vitrine (tâche 07) et le CDN
 * s'appuient dessus.
 */
@ApiTags('catalog')
@Public()
@Controller('catalog')
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly search: SearchService,
    private readonly size: SizeService,
  ) {}

  @Get('categories')
  @Header('Cache-Control', CACHE_CONTROL.long)
  @ApiOperation({ summary: 'Arbre des catégories (localisé)', operationId: 'getCatalogCategories' })
  @ApiOkResponse({ type: CategoryTreeDto })
  getCategories(@Query() query: LocaleQueryDto): Promise<CategoryTreeDto> {
    return this.catalog.getCategoryTree(query.locale);
  }

  @Get('products')
  @Header('Cache-Control', CACHE_CONTROL.medium)
  @ApiOperation({
    summary: 'Liste de produits filtrable et paginée par curseur',
    operationId: 'listCatalogProducts',
  })
  @ApiOkResponse({ type: ProductListDto })
  listProducts(@Query() query: CatalogFilterQueryDto): Promise<ProductListDto> {
    return this.catalog.listProducts(query);
  }

  @Get('sizes')
  @Header('Cache-Control', CACHE_CONTROL.long)
  @ApiOperation({
    summary: 'Index des tailles disponibles avec compte de produits',
    operationId: 'getCatalogSizeIndex',
  })
  @ApiOkResponse({ type: SizeIndexDto })
  getSizeIndex(): Promise<SizeIndexDto> {
    return this.catalog.getSizeIndex();
  }

  @Get('sizes/:label/equivalents')
  @Header('Cache-Control', CACHE_CONTROL.long)
  @ApiOperation({
    summary: 'Tailles équivalentes/compatibles (nominal ↔ réel)',
    operationId: 'getCatalogSizeEquivalents',
  })
  @ApiParam({ name: 'label', example: '16x25x1', description: 'Dimension en toute graphie' })
  @ApiOkResponse({ type: SizeEquivalentsDto })
  getSizeEquivalents(@Param('label') label: string): Promise<SizeEquivalentsDto> {
    return this.size.equivalents(label);
  }

  @Get('search/suggest')
  @Header('Cache-Control', CACHE_CONTROL.short)
  @ApiOperation({ summary: 'Autocomplétion (tailles + produits)', operationId: 'suggestCatalog' })
  @ApiOkResponse({ type: SuggestDto })
  suggest(@Query() query: SuggestQueryDto): Promise<SuggestDto> {
    return this.search.suggest(query);
  }

  @Get('search')
  @Header('Cache-Control', CACHE_CONTROL.short)
  @ApiOperation({
    summary: 'Recherche full-text/trigram tolérante aux fautes et aux dimensions',
    operationId: 'searchCatalog',
  })
  @ApiOkResponse({ type: ProductListDto })
  searchProducts(@Query() query: SearchQueryDto): Promise<ProductListDto> {
    return this.search.search(query);
  }

  @Get('products/:slug')
  @Header('Cache-Control', CACHE_CONTROL.medium)
  @ApiOperation({ summary: 'Fiche produit par slug localisé', operationId: 'getCatalogProduct' })
  @ApiParam({ name: 'slug', description: 'Slug localisé (fr/en)' })
  @ApiOkResponse({ type: ProductDetailDto })
  getProduct(
    @Param('slug') slug: string,
    @Query() query: LocaleQueryDto,
  ): Promise<ProductDetailDto> {
    return this.catalog.getProductBySlug(slug, query.locale);
  }
}
