import {buildReportEvidence, CONTEXT_AFTER, CONTEXT_BEFORE, EVIDENCE_MAX_BYTES} from './report-evidence';
import {MessageDto} from '../dtos/response/message.dto';
import {MessageEncryptionState} from '../enums/message-encryption-state.enum';
import {MessageType} from '../enums/message-type.enum';

const CAPTURED_AT = '2026-08-05T10:14:22.000Z';

function encode(text: string): string {
    return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

function msg(overrides: Partial<MessageDto> & {id: string; minute: number}): MessageDto {
    const {minute, ...rest} = overrides;
    return {
        createdAt: new Date(Date.UTC(2026, 7, 5, 10, minute)),
        updatedAt: new Date(Date.UTC(2026, 7, 5, 10, minute)),
        content: encode(`message ${rest.id}`),
        channelId: undefined,
        conversationId: 'conv_1',
        authorId: 'user_them',
        isPending: false,
        isFailed: false,
        attachments: [],
        inReplyTo: undefined,
        mentions: [],
        encryptionState: MessageEncryptionState.Encrypted,
        mlsEpoch: undefined,
        mlsSequenceNumber: undefined,
        senderDeviceId: undefined,
        type: MessageType.Message,
        ...rest,
    };
}

/** n messages, oldest first, ids m0..m(n-1). */
function conversation(n: number): MessageDto[] {
    return Array.from({length: n}, (_, i) => msg({id: `m${i}`, minute: i}));
}

describe('buildReportEvidence', () => {
    it('takes a window around the reported message rather than the whole conversation', () => {
        const messages = conversation(60);

        const evidence = buildReportEvidence({
            messages,
            reportedMessageId: 'm30',
            conversationId: 'conv_1',
            capturedAt: CAPTURED_AT,
        })!;

        expect(evidence.messages.length).toBe(CONTEXT_BEFORE + CONTEXT_AFTER + 1);
        expect(evidence.messages[0].id).toBe('m20');
        expect(evidence.messages.at(-1)!.id).toBe('m33');
    });

    it('marks exactly one message as the reported one', () => {
        const evidence = buildReportEvidence({
            messages: conversation(20),
            reportedMessageId: 'm10',
            capturedAt: CAPTURED_AT,
        })!;

        expect(evidence.messages.filter(m => m.reported).length).toBe(1);
        expect(evidence.messages.find(m => m.reported)!.id).toBe('m10');
    });

    it('sorts by sent time, so an out-of-order store still produces a readable transcript', () => {
        const shuffled = [msg({id: 'c', minute: 3}), msg({id: 'a', minute: 1}), msg({id: 'b', minute: 2})];

        const evidence = buildReportEvidence({
            messages: shuffled,
            reportedMessageId: 'b',
            capturedAt: CAPTURED_AT,
        })!;

        expect(evidence.messages.map(m => m.id)).toEqual(['a', 'b', 'c']);
    });

    it('decodes bodies to plaintext, which is the only copy staff will ever see', () => {
        const evidence = buildReportEvidence({
            messages: [msg({id: 'x', minute: 1, content: encode('say that again')})],
            reportedMessageId: 'x',
            capturedAt: CAPTURED_AT,
        })!;

        expect(evidence.messages[0].content).toBe('say that again');
    });

    it('reduces attachments to metadata instead of base64', () => {
        const withFile = msg({
            id: 'x',
            minute: 1,
            attachments: [{id: 'a1', fileName: 'proof.png', contentType: 'image/png', url: 'https://cdn/x'}],
        });

        const evidence = buildReportEvidence({
            messages: [withFile],
            reportedMessageId: 'x',
            capturedAt: CAPTURED_AT,
        })!;

        expect(evidence.messages[0].content).toContain('[attachment: image/png "proof.png"]');
        expect(evidence.messages[0].content).not.toContain('https://cdn/x');
    });

    it('does not leak a body this device could not verify', () => {
        const undecryptable = msg({id: 'x', minute: 1, undecryptable: true, content: encode('never rendered')});

        const evidence = buildReportEvidence({
            messages: [undecryptable],
            reportedMessageId: 'x',
            capturedAt: CAPTURED_AT,
        })!;

        expect(evidence.messages[0].content).not.toContain('never rendered');
    });

    it('sets encrypted honestly from the reported message', () => {
        const plain = msg({id: 'x', minute: 1, encryptionState: MessageEncryptionState.Plain});

        expect(buildReportEvidence({messages: [plain], reportedMessageId: 'x', capturedAt: CAPTURED_AT})!.encrypted)
            .toBe(false);
        expect(buildReportEvidence({messages: conversation(3), reportedMessageId: 'm1', capturedAt: CAPTURED_AT})!.encrypted)
            .toBe(true);
    });

    it('leaves out pending and ephemeral entries, which have no server-side row', () => {
        const messages = [
            msg({id: 'real', minute: 1}),
            msg({id: 'pending', minute: 2, isPending: true}),
            msg({id: 'ephemeral', minute: 3, isEphemeral: true}),
        ];

        const evidence = buildReportEvidence({messages, reportedMessageId: 'real', capturedAt: CAPTURED_AT})!;

        expect(evidence.messages.map(m => m.id)).toEqual(['real']);
    });

    it('never pulls in another conversation, however the caller\'s store is shaped', () => {
        // A signal store of entities holds every message this client has: without scoping, the
        // "context" window would splice in whoever else was talking at the same minute.
        const mine = conversation(6);
        const somebodyElses = Array.from({length: 6}, (_, i) =>
            msg({id: `other${i}`, minute: i, conversationId: 'conv_other', authorId: 'user_stranger'}));

        const evidence = buildReportEvidence({
            messages: [...mine, ...somebodyElses],
            reportedMessageId: 'm3',
            conversationId: 'conv_1',
            capturedAt: CAPTURED_AT,
        })!;

        expect(evidence.messages.every(m => m.id.startsWith('m'))).toBe(true);
        expect(evidence.messages.some(m => m.id.startsWith('other'))).toBe(false);
    });

    it('scopes a channel report to that channel', () => {
        const here = Array.from({length: 4}, (_, i) =>
            msg({id: `h${i}`, minute: i, conversationId: undefined, channelId: 'chan_1'}));
        const elsewhere = Array.from({length: 4}, (_, i) =>
            msg({id: `e${i}`, minute: i, conversationId: undefined, channelId: 'chan_2'}));

        const evidence = buildReportEvidence({
            messages: [...here, ...elsewhere],
            reportedMessageId: 'h2',
            channelId: 'chan_1',
            capturedAt: CAPTURED_AT,
        })!;

        expect(evidence.messages.map(m => m.id)).toEqual(['h0', 'h1', 'h2', 'h3']);
    });

    it('returns null when the reported message is not among those held', () => {
        expect(buildReportEvidence({
            messages: conversation(5),
            reportedMessageId: 'not-loaded',
            capturedAt: CAPTURED_AT,
        })).toBeNull();
    });

    describe('the 16 KB ceiling the server refuses past', () => {
        function bytes(value: unknown): number {
            return new TextEncoder().encode(JSON.stringify(value)).length;
        }

        it('truncates from the oldest end and keeps the reported message', () => {
            const long = 'x'.repeat(3000);
            const messages = conversation(20).map(m => ({...m, content: encode(long)}));

            const evidence = buildReportEvidence({
                messages,
                reportedMessageId: 'm10',
                capturedAt: CAPTURED_AT,
            })!;

            expect(bytes(evidence)).toBeLessThanOrEqual(EVIDENCE_MAX_BYTES);
            expect(evidence.messages.some(m => m.reported)).toBe(true);
            // What survived is the newest end of the window, not the oldest.
            expect(evidence.messages.at(-1)!.id).toBe('m13');
        });

        it('clips a single over-long message rather than sending nothing', () => {
            const huge = 'y'.repeat(40_000);

            const evidence = buildReportEvidence({
                messages: [msg({id: 'x', minute: 1, content: encode(huge)})],
                reportedMessageId: 'x',
                capturedAt: CAPTURED_AT,
            })!;

            expect(bytes(evidence)).toBeLessThanOrEqual(EVIDENCE_MAX_BYTES);
            expect(evidence.messages.length).toBe(1);
            expect(evidence.messages[0].reported).toBe(true);
        });

        it('stays inside the ceiling when the bodies are multi-byte', () => {
            // Four bytes per character: counting characters instead of bytes would overshoot.
            const emoji = '🙃'.repeat(6000);

            const evidence = buildReportEvidence({
                messages: [msg({id: 'x', minute: 1, content: encode(emoji)})],
                reportedMessageId: 'x',
                capturedAt: CAPTURED_AT,
            })!;

            expect(bytes(evidence)).toBeLessThanOrEqual(EVIDENCE_MAX_BYTES);
        });
    });

    it('carries whichever container id it was given, and never both', () => {
        const inChannel = buildReportEvidence({
            messages: [msg({id: 'x', minute: 1, conversationId: undefined, channelId: 'chan_1'})],
            reportedMessageId: 'x',
            channelId: 'chan_1',
            capturedAt: CAPTURED_AT,
        })!;

        expect(inChannel.channelId).toBe('chan_1');
        expect(inChannel.conversationId).toBeUndefined();
    });
});
