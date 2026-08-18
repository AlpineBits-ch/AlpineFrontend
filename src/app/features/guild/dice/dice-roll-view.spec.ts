import {describe, expect, it} from 'vitest';
import {MessageDto} from '../../../dtos/response/message.dto';
import {MessageType} from '../../../enums/message-type.enum';
import {MessageEncryptionState} from '../../../enums/message-encryption-state.enum';
import {diceRollFromMessage, diceRollView} from './dice-roll-view';

const TERMS = [
    {notation: '4d6kh3', sign: 1, constant: null, dice: [6, 5, 3, 1], kept: [6, 5, 3], subtotal: 14},
    {notation: '2', sign: 1, constant: 2, dice: [], kept: [], subtotal: 2},
];

function message(embedsJson: string | undefined): MessageDto {
    return {
        id: 'mesg_1',
        createdAt: new Date(),
        updatedAt: new Date(),
        content: 'Perception: 4d6kh3 (6, 5, 3, ~1) + 2 = 16',
        channelId: 'chan_1',
        conversationId: undefined,
        authorId: 'user_1',
        isPending: false,
        isFailed: false,
        attachments: [],
        inReplyTo: undefined,
        mentions: [],
        encryptionState: MessageEncryptionState.Plain,
        mlsEpoch: undefined,
        mlsSequenceNumber: undefined,
        senderDeviceId: undefined,
        type: MessageType.DiceRoll,
        embedsJson,
    };
}

describe('diceRollView', () => {
    it('marks which dice counted and which were dropped', () => {
        const view = diceRollView({expression: '4d6kh3 + 2', total: 16, breakdown: '', terms: TERMS});
        expect(view.terms[0].faces.map(f => [f.value, f.kept])).toEqual([
            [6, true],
            [5, true],
            [3, true],
            [1, false],
        ]);
    });

    it('marks the highest and lowest face of any die size, not only a d20', () => {
        const view = diceRollView({expression: '4d6kh3 + 2', total: 16, breakdown: '', terms: TERMS});
        const faces = view.terms[0].faces;
        expect(faces[0].isMax).toBe(true);
        expect(faces[1].isMax).toBe(false);
        expect(faces[3].isMin).toBe(true);
        expect(faces[3].kept).toBe(false);
    });

    it('drops only one of a repeated face when only one was kept', () => {
        const view = diceRollView({
            expression: '2d6kh1',
            total: 4,
            breakdown: '',
            terms: [{notation: '2d6kh1', sign: 1, constant: null, dice: [4, 4], kept: [4], subtotal: 4}],
        });
        expect(view.terms[0].faces.map(f => f.kept)).toEqual([true, false]);
    });

    it('reads the die size back off the notation', () => {
        const view = diceRollView({
            expression: '1d20',
            total: 13,
            breakdown: '',
            terms: [{notation: '1d20', sign: 1, constant: null, dice: [13], kept: [13], subtotal: 13}],
        });
        expect(view.terms[0].sides).toBe(20);
        // One die and no modifier: the face is the result, so no separate total is drawn.
        expect(view.isSingleDie).toBe(true);
    });

    it('is not a single die once a modifier is added', () => {
        expect(
            diceRollView({expression: '4d6kh3 + 2', total: 16, breakdown: '', terms: TERMS}).isSingleDie,
        ).toBe(false);
    });

    it('marks a die that exploded past its own maximum', () => {
        const view = diceRollView({
            expression: '1d10!',
            total: 14,
            breakdown: '',
            terms: [{notation: '1d10!', sign: 1, constant: null, dice: [14], kept: [14], subtotal: 14}],
        });
        expect(view.terms[0].faces[0].exploded).toBe(true);
    });
});

describe('diceRollFromMessage', () => {
    it('reads the roll off the embed the server hangs on the message', () => {
        const embeds = JSON.stringify([
            {
                type: 'rich',
                title: 'Perception',
                dice: {expression: '4d6kh3 + 2', total: 16, breakdown: 'x', terms: TERMS},
            },
        ]);
        const view = diceRollFromMessage(message(embeds));
        expect(view?.total).toBe(16);
        expect(view?.reason).toBe('Perception');
    });

    // A null is the signal to fall back to `content`, which already carries the same result.
    it('gives up rather than half-render when the embed cannot be read', () => {
        expect(diceRollFromMessage(message(undefined))).toBeNull();
        expect(diceRollFromMessage(message('not json'))).toBeNull();
        expect(diceRollFromMessage(message(JSON.stringify([{type: 'rich'}])))).toBeNull();
        expect(diceRollFromMessage(message(JSON.stringify([{dice: {total: 3}}])))).toBeNull();
    });
});
