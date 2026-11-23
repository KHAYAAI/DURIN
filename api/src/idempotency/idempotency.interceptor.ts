import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { IdempotencyService } from './idempotency.service';
import { REQUEST_CONTEXT_KEY, RequestContext } from '../common/request-context';

/**
 * Applies idempotency when `Idempotency-Key` header is present
 * and the request is authenticated.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly idempotency: IdempotencyService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();

    const key: string | undefined = request.headers['idempotency-key'];
    const ctx = request[REQUEST_CONTEXT_KEY] as RequestContext | undefined;

    if (!key || !ctx) {
      return next.handle();
    }

    const requestHash = this.idempotency.hashRequest(
      request.method,
      request.route?.path ?? request.url,
      request.body,
    );

    const result = await this.idempotency.begin(ctx.organisationId, key, requestHash);
    if (result.hit) {
      response.status(result.status);
      return of(result.body);
    }

    return next.handle().pipe(
      tap(async (body) => {
        const status = response.statusCode ?? 200;
        await this.idempotency.complete(ctx.organisationId, key, status, body);
      }),
    );
  }
}
