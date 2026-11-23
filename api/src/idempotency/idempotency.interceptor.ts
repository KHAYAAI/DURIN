import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, catchError, from, mergeMap, of, throwError } from 'rxjs';
import { IdempotencyService } from './idempotency.service';
import { REQUEST_CONTEXT_KEY, RequestContext } from '../common/request-context';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Responses that contain one-time secrets (API key secrets, webhook signing secrets, TOTP secrets)
 * must never be persisted for replay, so idempotency is not applied to these routes.
 */
const SECRET_BEARING = [/\/api_keys\/?$/, /\/webhook_endpoints\/?$/, /\/webhook_endpoints\/[^/]+\/rotate_secret\/?$/, /\/auth\/mfa\/enroll\/?$/];

/**
 * Applies idempotency to authenticated, mutating requests that carry an `Idempotency-Key`.
 * The response is persisted BEFORE it is sent, so a client that retries immediately after
 * receiving a response always gets a replay, never an "in progress" conflict.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly log = new Logger(IdempotencyInterceptor.name);

  constructor(private readonly idempotency: IdempotencyService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();

    if (SAFE_METHODS.has(request.method)) return next.handle();

    const key: string | undefined = request.headers['idempotency-key'];
    const ctx = request[REQUEST_CONTEXT_KEY] as RequestContext | undefined;
    if (!key || !ctx) return next.handle();
    if (SECRET_BEARING.some((re) => re.test(String(request.originalUrl ?? request.url).split('?')[0]))) return next.handle();
    if (key.length > 255) {
      throw new BadRequestException({ code: 'INVALID_IDEMPOTENCY_KEY', message: 'Idempotency-Key must be at most 255 characters' });
    }

    // Hash the actual URL (with resource ids), not the route pattern.
    const path = String(request.originalUrl ?? request.url).split('?')[0]!;
    const requestHash = this.idempotency.hashRequest(request.method, path, request.body);

    const result = await this.idempotency.begin(ctx.organisationId, key, requestHash);
    if (result.hit) {
      response.status(result.status);
      response.setHeader('Idempotent-Replayed', 'true');
      return of(result.body);
    }

    return next.handle().pipe(
      mergeMap((body) =>
        from(
          this.idempotency
            .complete(ctx.organisationId, key, response.statusCode ?? 200, body)
            .catch((e) => this.log.error(`Failed to persist idempotent response: ${e instanceof Error ? e.message : e}`))
            .then(() => body),
        ),
      ),
      catchError((err) =>
        from(this.idempotency.release(ctx.organisationId, key).catch(() => undefined)).pipe(mergeMap(() => throwError(() => err))),
      ),
    );
  }
}
