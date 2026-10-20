import { type INestApplication, StandardSchemaValidationPipe } from '@nestjs/common';
import { setupOpenApi } from './openapi.js';
import { requestLogger } from './request-log.middleware.js';

/** Shared by main.ts and the e2e tests so both run with the same prefix, pipes and logging. */
export function configureApp(
  app: INestApplication,
  log: (line: string) => void = () => undefined,
): void {
  app.setGlobalPrefix('api');
  app.use(requestLogger(log));
  app.useGlobalPipes(new StandardSchemaValidationPipe());
  setupOpenApi(app);
}
