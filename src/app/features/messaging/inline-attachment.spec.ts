import {describe, expect, it} from 'vitest';
import {
    inlineAttachmentIds,
    inlineAttachmentToken,
    isAttachmentId,
    stripInlineAttachments,
} from './inline-attachment';

const A = 'atac_01HZX9K2QW';
const B = 'atac_01HZX9K2QX';

describe('inlineAttachmentToken', () => {
    it('round-trips through the id reader', () => {
        expect(inlineAttachmentIds(inlineAttachmentToken(A))).toEqual([A]);
    });
});

describe('inlineAttachmentIds', () => {
    it('finds tokens in reading order', () => {
        const content = `before ${inlineAttachmentToken(B)} between ${inlineAttachmentToken(A)} after`;
        expect(inlineAttachmentIds(content)).toEqual([B, A]);
    });

    it('reports a repeated token once', () => {
        const token = inlineAttachmentToken(A);
        expect(inlineAttachmentIds(`${token} and again ${token}`)).toEqual([A]);
    });

    it('ignores an id with the wrong prefix', () => {
        expect(inlineAttachmentIds('<att:mesg_01HZX9K2QW>')).toEqual([]);
    });

    it('ignores a persona mention', () => {
        expect(inlineAttachmentIds('<@pers_01HZX9K2QW>')).toEqual([]);
    });

    it('finds nothing in a body that has none', () => {
        expect(inlineAttachmentIds('just a sentence about atac_ things')).toEqual([]);
    });
});

describe('isAttachmentId', () => {
    it('accepts a real id and rejects the rest', () => {
        expect(isAttachmentId(A)).toBe(true);
        expect(isAttachmentId('pers_01HZX9K2QW')).toBe(false);
        expect(isAttachmentId('atac_')).toBe(false);
        expect(isAttachmentId(null)).toBe(false);
    });
});

describe('stripInlineAttachments', () => {
    it('leaves the prose behind', () => {
        expect(stripInlineAttachments(`a ${inlineAttachmentToken(A)}b`)).toBe('a b');
    });
});
