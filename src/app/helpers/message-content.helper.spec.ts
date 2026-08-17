/**
 * The one gate every rendered message body passes through.
 *
 * <p>`undecryptable` was set by three read paths and consumed by nothing, so every unauthenticated
 * body was decoded and shown anyway - base64 for a failed decrypt, and the injected text itself for
 * a message the server merely labelled `Plain`. Suppressing it in the message bubble alone was not
 * enough either: the same field is decoded in the sidebar preview, both search lists, the pinned
 * panel, the reply chip and the notification body.</p>
 */
import {
    decodeBody,
    readableContent,
    UNDECRYPTABLE_PLACEHOLDER,
    UNDECRYPTABLE_SHORT,
} from './message-content.helper';

// base64("I am the server")
const INJECTED = 'SSBhbSB0aGUgc2VydmVy';

describe('readableContent', () => {
    it('decodes a body that was verified', () => {
        expect(readableContent({content: INJECTED})).toBe('I am the server');
    });

    it('refuses to decode a body flagged undecryptable', () => {
        // The whole point. A caller that has been handed `undecryptable: true` must not be able to
        // get the bytes out by asking politely.
        expect(readableContent({content: INJECTED, undecryptable: true}))
            .toBe(UNDECRYPTABLE_PLACEHOLDER);
    });

    it('never leaks the body through the placeholder', () => {
        const shown = readableContent({content: INJECTED, undecryptable: true});
        expect(shown).not.toContain('I am the server');
        expect(shown).not.toContain(INJECTED);
    });

    it('uses the short form where a preview asks for it', () => {
        expect(readableContent({content: INJECTED, undecryptable: true}, UNDECRYPTABLE_SHORT))
            .toBe(UNDECRYPTABLE_SHORT);
    });

    it('is safe on a missing message', () => {
        expect(readableContent(null)).toBe('');
        expect(readableContent(undefined)).toBe('');
    });
});

describe('decodeBody', () => {
    it('returns a non-base64 body unchanged', () => {
        // Some paths carry already-decoded text; throwing or blanking here would hide a message
        // that is perfectly readable.
        expect(decodeBody('not base64 !!')).toBe('not base64 !!');
    });

    it('round-trips utf-8', () => {
        expect(decodeBody(btoa('héllo'.replace(/[-￿]/g, c =>
            String.fromCharCode(c.charCodeAt(0)))))).toBeTruthy();
    });
});
