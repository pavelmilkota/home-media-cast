import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';
import { configureApp } from './configure-app.js';
import { serveWeb } from './serve-web.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const http = new Logger('HTTP');
  configureApp(app, (line) => http.log(line));
  const config = loadConfig();
  if (!serveWeb(app, config.webDist)) {
    http.warn(`No web build at ${config.webDist}; serving the API only (run pnpm build)`);
  }
  await app.listen(config.port);
}

void bootstrap();
