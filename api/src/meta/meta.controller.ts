import { Controller, Get, Header } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';

@Controller()
export class MetaController {
  @Get('openapi.yaml')
  @Header('Content-Type', 'application/yaml')
  openapiYaml() {
    const candidates = [
      join(__dirname, '..', '..', 'openapi', 'openapi.yaml'),
      join(process.cwd(), 'openapi', 'openapi.yaml'),
      join(process.cwd(), 'apps', 'api', 'openapi', 'openapi.yaml'),
    ];
    for (const p of candidates) {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        /* try next */
      }
    }
    return 'openapi: 3.1.0\ninfo: { title: DURIN, version: 0.8.0 }\n# file not found at runtime — see apps/api/openapi/openapi.yaml\n';
  }

  @Get('version')
  version() {
    return {
      service: 'durin-api',
      version: '0.8.0',
      api: 'v1',
      openapi: '/v1/openapi.yaml',
      mode: process.env.NODE_ENV === 'production' ? 'production' : 'sandbox',
      readiness: {
        api_surface: 'high',
        auth: 'high',
        money_movement: 'sandbox_only',
        compliance: 'program_scaffold_high',
        dashboard: 'high_scaffold',
        hardening: 'high_engineering',
        regulatory: 'prepared_not_licensed',
      },
    };
  }
}
