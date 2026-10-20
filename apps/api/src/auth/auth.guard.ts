import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DeviceService, type AuthenticatedDevice } from './device.service.js';
import { IS_PUBLIC } from './public.decorator.js';

export type AuthedRequest = Request & { device: AuthenticatedDevice };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly devices: DeviceService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    const device = scheme === 'Bearer' && token ? this.devices.authenticate(token) : undefined;
    if (!device) throw new UnauthorizedException('Missing, invalid or revoked device token');
    req.device = device;
    return true;
  }
}
