import {describe, expect, it} from 'vitest';
import {parseInstallBotLink} from './bot-install-link.util';

describe('parseInstallBotLink', () => {
    it('parses a minimal link with only client_id', () => {
        const result = parseInstallBotLink('venta://install-bot?client_id=user_2c9f');
        expect(result).toEqual({
            clientId: 'user_2c9f',
            permissions: 0n,
            guildId: undefined,
            redirectUri: undefined,
            state: undefined,
        });
    });

    it('returns null when client_id is missing', () => {
        const result = parseInstallBotLink('venta://install-bot?permissions=513');
        expect(result).toBeNull();
    });

    it('returns null when client_id is empty', () => {
        const result = parseInstallBotLink('venta://install-bot?client_id=&permissions=513');
        expect(result).toBeNull();
    });

    it('parses permissions as a bigint', () => {
        const result = parseInstallBotLink('venta://install-bot?client_id=abc&permissions=513');
        expect(result?.permissions).toBe(513n);
    });

    it('defaults permissions to 0n when malformed', () => {
        const result = parseInstallBotLink('venta://install-bot?client_id=abc&permissions=not-a-number');
        expect(result?.permissions).toBe(0n);
    });

    it('parses guild_id when present', () => {
        const result = parseInstallBotLink('venta://install-bot?client_id=abc&guild_id=g1');
        expect(result?.guildId).toBe('g1');
    });

    it('leaves guild_id undefined when absent', () => {
        const result = parseInstallBotLink('venta://install-bot?client_id=abc');
        expect(result?.guildId).toBeUndefined();
    });

    it('decodes a URL-encoded redirect_uri', () => {
        const result = parseInstallBotLink(
            'venta://install-bot?client_id=abc&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback%3Fx%3D1',
        );
        expect(result?.redirectUri).toBe('https://example.com/callback?x=1');
    });

    it('echoes state through unchanged', () => {
        const result = parseInstallBotLink('venta://install-bot?client_id=abc&state=xyz123');
        expect(result?.state).toBe('xyz123');
    });

    it('parses all params together', () => {
        const result = parseInstallBotLink(
            'venta://install-bot?client_id=user_2c9f&permissions=513&guild_id=g1&redirect_uri=https%3A%2F%2Fexample.com&state=xyz',
        );
        expect(result).toEqual({
            clientId: 'user_2c9f',
            permissions: 513n,
            guildId: 'g1',
            redirectUri: 'https://example.com',
            state: 'xyz',
        });
    });

    it('returns null for a non-install-bot venta:// url', () => {
        const result = parseInstallBotLink('venta://invite/abc123');
        expect(result).toBeNull();
    });
});
