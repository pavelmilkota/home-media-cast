import { SetMetadata } from '@nestjs/common';

export const IS_GUEST_ALLOWED = 'isGuestAllowed';
/**
 * Lets a guest token reach a handler. Access is deny by default: a handler without this answers a
 * guest with 403 `guest_forbidden`, so a new route cannot leak to guests by being forgotten.
 */
export const GuestAllowed = () => SetMetadata(IS_GUEST_ALLOWED, true);
