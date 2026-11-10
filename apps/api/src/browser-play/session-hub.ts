import type { ActiveBrowserSession, BrowserSessionService } from './browser-session.service.js';
import type { ExternalSessionService } from './external-session.service.js';

/**
 * The household's one active session, whether it plays in a browser's player or in an external
 * one. The coordinator and the handoff routes see only this.
 */
export class SessionHub {
  constructor(
    private readonly browser: BrowserSessionService,
    private readonly external: ExternalSessionService,
  ) {}

  /**
   * A playing session. Several can play at once (see `alongside`), so with `deviceId` that device's
   * own comes first.
   */
  active(deviceId?: string): ActiveBrowserSession | undefined {
    const own =
      deviceId === undefined
        ? undefined
        : (this.browser.active({ only: deviceId }) ?? this.external.active({ only: deviceId }));
    return own ?? this.browser.active() ?? this.external.active();
  }

  /** A session playing on another device than `deviceId`: what "Continue here" there takes. */
  activeElsewhere(deviceId: string): ActiveBrowserSession | undefined {
    return this.browser.active({ except: deviceId }) ?? this.external.active({ except: deviceId });
  }

  /** `deviceId`'s own external player, if it plays: "Continue here" can bring it into the browser. */
  activeExternalOf(deviceId: string): ActiveBrowserSession | undefined {
    return this.external.active({ only: deviceId });
  }

  /** A browser player reported it plays. False if that session is gone or not this device's. */
  confirm(id: string, deviceId: string): boolean {
    return this.browser.confirm(id, deviceId);
  }

  /**
   * Session `id` started playing: whether it takes over at all (`stopsTv`), and ends the sessions it
   * replaces. A handoff ends every other one; a converted play only those not playing alongside.
   */
  async takeOverFor(id: string): Promise<{ stopsTv: boolean }> {
    const role = this.browser.roleOf(id) ?? this.external.roleOf(id);
    if (!role || role.alongside) return { stopsTv: false };
    await Promise.all([
      this.browser.endOthers(id, role.takeover),
      this.external.endOthers(id, role.takeover),
    ]);
    return { stopsTv: true };
  }

  /** True if session `id` is a guest's. */
  isGuest(id: string): boolean {
    return this.browser.isGuest(id) || this.external.isGuest(id);
  }

  /**
   * A guest wants to start: the dead sessions of other devices end. A live one keeps playing next
   * to the guest's: a guest is never refused because another device plays.
   */
  async claimForGuest(deviceId: string): Promise<void> {
    await Promise.all([
      this.browser.endDeadOthers(deviceId),
      this.external.endDeadOthers(deviceId),
    ]);
  }

  /** Marks session `id` as sent to the TV; returns how to undo it. */
  handOver(id: string): (() => void) | undefined {
    return this.browser.handOver(id) ?? this.external.handOver(id);
  }

  /** The TV started something: ends every session but those playing alongside, not sent to the TV. */
  async endForTv(): Promise<void> {
    await Promise.all([this.browser.endForTv(), this.external.endForTv()]);
  }

  /** A guest paired: its sessions start saving progress. */
  markPaired(deviceId: string): void {
    this.browser.markPaired(deviceId);
    this.external.markPaired(deviceId);
  }

  async endAll(): Promise<void> {
    await Promise.all([this.browser.endAll(), this.external.endAll()]);
  }

  onChange(listener: () => void): void {
    this.browser.onChange(listener);
    this.external.onChange(listener);
  }
}
