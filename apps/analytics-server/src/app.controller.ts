import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get()
  root() {
    return {
      service: 'clklog-analytics-server',
      version: 'v1',
      health: '/sa/api/health',
      docs: 'https://github.com/clklog/clklog-manager',
    };
  }

  @Get('sa/api/health')
  health() {
    return { status: 'ok', service: 'clklog-analytics-server' };
  }
}
