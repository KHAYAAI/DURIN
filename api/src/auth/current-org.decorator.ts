import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { REQUEST_CONTEXT_KEY, RequestContext } from '../common/request-context';

export const CurrentOrg = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestContext => {
    const request = ctx.switchToHttp().getRequest();
    return request[REQUEST_CONTEXT_KEY];
  },
);
