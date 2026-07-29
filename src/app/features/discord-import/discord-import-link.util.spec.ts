import {describe, expect, it} from 'vitest';
import {parseDiscordImportLink} from './discord-import-link.util';

describe('parseDiscordImportLink', () => {
    it('parses a jobId', () => {
        const result = parseDiscordImportLink('venta://discord-import?jobId=job_123');
        expect(result).toEqual({jobId: 'job_123', error: undefined});
    });

    it('parses an error', () => {
        const result = parseDiscordImportLink('venta://discord-import?error=access_denied');
        expect(result).toEqual({jobId: undefined, error: 'access_denied'});
    });

    it('returns null when neither jobId nor error is present', () => {
        const result = parseDiscordImportLink('venta://discord-import?foo=bar');
        expect(result).toBeNull();
    });

    it('returns null for a non-discord-import venta:// url', () => {
        const result = parseDiscordImportLink('venta://install-bot?client_id=abc');
        expect(result).toBeNull();
    });

    it('decodes a URL-encoded error message', () => {
        const result = parseDiscordImportLink('venta://discord-import?error=user%20denied%20consent');
        expect(result?.error).toBe('user denied consent');
    });
});
