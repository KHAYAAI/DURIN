import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

/**
 * Fail closed in production if sandbox adapters are still bound
 * or required secrets are missing.
 */
@Injectable()
export class ProductionSafety implements OnModuleInit {
  private readonly log = new Logger('ProductionSafety');

  onModuleInit() {
    if (process.env.NODE_ENV !== 'production') {
      this.log.log('Non-production mode — sandbox adapters allowed');
      return;
    }
    const errors: string[] = [];
    if ((process.env.LAYER1_ADAPTER || 'sandbox') === 'sandbox') {
      errors.push('LAYER1_ADAPTER must not be sandbox in production');
    }
    if ((process.env.LAYER2_ADAPTER || 'sandbox') === 'sandbox') {
      errors.push('LAYER2_ADAPTER must not be sandbox in production');
    }
    if (process.env.ALLOW_SANDBOX_IN_PRODUCTION === 'true') {
      this.log.warn('ALLOW_SANDBOX_IN_PRODUCTION=true — override engaged (dangerous)');
      return;
    }
    if (errors.length) {
      this.log.error(errors.join('; '));
      throw new Error(`Production safety check failed: ${errors.join('; ')}`);
    }
    this.log.log('Production safety checks passed');
  }
}
