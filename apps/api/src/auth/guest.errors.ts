/** A guest token reached a route only paired devices may use. */
export class GuestForbiddenError extends Error {
  constructor() {
    super('This needs a paired device. Pair this device with the TV first.');
    this.name = 'GuestForbiddenError';
  }
}

/** `GUEST_PLAYBACK_ENABLED=false`: devices must pair. */
export class GuestDisabledError extends Error {
  constructor() {
    super('Guest access is switched off. Pair this device with the TV.');
    this.name = 'GuestDisabledError';
  }
}
