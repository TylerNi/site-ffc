import { type INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

export const API_VERSION = '0.1.0';

export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('FFC API')
    .setDescription('API de la plateforme Filtration Montréal / Furnace Filters Canada')
    .setVersion(API_VERSION)
    .build();
  return SwaggerModule.createDocument(app, config);
}
