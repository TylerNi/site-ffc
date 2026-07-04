import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { healthStatusSchema } from '@ffc/core';
import { API_VERSION } from '../../openapi';
import { Public } from '../auth/decorators';
import { HealthResponseDto } from './dto/health-response.dto';

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Public()
  @Get()
  @ApiOperation({ summary: "État de santé de l'API", operationId: 'getHealth' })
  @ApiOkResponse({ type: HealthResponseDto })
  getHealth(): HealthResponseDto {
    // Le schéma zod partagé (@ffc/core) valide la réponse côté API;
    // les clients valident avec le même schéma ce qu'ils reçoivent.
    return healthStatusSchema.parse({
      status: 'ok',
      service: 'ffc-api',
      version: API_VERSION,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
    });
  }
}
