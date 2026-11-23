import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Maps database errors to proper HTTP responses so clients get 4xx for their mistakes
 * (e.g. a malformed id) and never see database internals in a 500.
 */
@Catch(Prisma.PrismaClientKnownRequestError, Prisma.PrismaClientValidationError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger('Database');

  catch(exception: Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientValidationError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    const send = (status: number, code: string, message: string) => res.status(status).json({ statusCode: status, code, message });

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return send(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', 'Invalid request');
    }
    switch (exception.code) {
      case 'P2023':
        return send(HttpStatus.BAD_REQUEST, 'INVALID_ID', 'Malformed identifier');
      case 'P2025':
        return send(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Resource not found');
      case 'P2002':
        return send(HttpStatus.CONFLICT, 'CONFLICT', 'Resource already exists');
      default:
        this.log.error(`Unhandled database error ${exception.code}: ${exception.message}`);
        return send(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Internal error');
    }
  }
}
