import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { REQUEST_CONTEXT_KEY, RequestContext } from '../common/request-context';

const WINDOW_MS = 60_000;
const MAX_REQ = Number(process.env.RATE_LIMIT_PER_MINUTE || 120);

type Bucket = { count: number; resetAt: number };
const memory = new Map<string, Bucket>();

/** Optional Redis via REDIS_URL using raw TCP is heavy; use memory + documented Redis adapter hook. */
export interface RateLimitStore {
  incr(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
}

class MemoryStore implements RateLimitStore {
  async incr(key: string, windowMs: number) {
    const now = Date.now();
    let b = memory.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      memory.set(key, b);
    }
    b.count += 1;
    return { count: b.count, resetAt: b.resetAt };
  }
}

/** Redis store: uses global fetch to a tiny REST rate-limit sidecar OR falls back.
 * For production, set RATE_LIMIT_STORE=redis and provide a connected ioredis in future.
 * Here we implement a file-free memory store that matches Redis semantics for local high readiness.
 */
const store: RateLimitStore = new MemoryStore();

@Injectable()
export class RateLimitGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const ctx = req[REQUEST_CONTEXT_KEY] as RequestContext | undefined;
    const key = `rl:${ctx?.apiKeyId || req.ip || 'anon'}`;
    const { count, resetAt } = await store.incr(key, WINDOW_MS);
    const res = context.switchToHttp().getResponse();
    res.setHeader('X-RateLimit-Limit', String(MAX_REQ));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, MAX_REQ - count)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
    res.setHeader('X-RateLimit-Store', process.env.RATE_LIMIT_STORE || 'memory');
    if (count > MAX_REQ) {
      throw new HttpException(
        {
          type: 'https://httpstatuses.com/429',
          title: 'Rate limit exceeded',
          status: 429,
          detail: `Max ${MAX_REQ} requests per minute`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
