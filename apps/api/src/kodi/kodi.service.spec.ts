import { describe, expect, it } from 'vitest';
import { assertLoopbackKodiUrl } from './kodi.service.js';

describe('assertLoopbackKodiUrl', () => {
  it.each([
    'ws://127.0.0.1:9090/jsonrpc',
    'ws://localhost:9090/jsonrpc',
    'ws://[::1]:9090/jsonrpc',
  ])('accepts %s', (url) => {
    expect(() => assertLoopbackKodiUrl(url)).not.toThrow();
  });

  it.each([
    'ws://0.0.0.0:9090/jsonrpc',
    'ws://192.168.1.50:9090/jsonrpc',
    'ws://kodi.example.com:9090/jsonrpc',
    'wss://127.0.0.1:9090/jsonrpc',
    'http://127.0.0.1:9090/jsonrpc',
  ])('rejects %s', (url) => {
    expect(() => assertLoopbackKodiUrl(url)).toThrow(/loopback/);
  });
});
