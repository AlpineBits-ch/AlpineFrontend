import {describe, expect, it} from 'vitest';
import {CALL_STATUS_PRECEDENCE, CallStatusInput, CallStatusKind, resolveCallStatus} from './call-status';
import en from '../../../assets/i18n/locales/en.json';

const OK: CallStatusInput = {rtcState: 'connected', stalledAudio: false, aloneUntil: null};

/** The input that, on its own, produces each kind. */
const TRIGGERS: Record<CallStatusKind, Partial<CallStatusInput>> = {
    failed: {rtcState: 'failed'},
    lost: {rtcState: 'disconnected'},
    connecting: {rtcState: 'connecting'},
    'no-audio': {stalledAudio: true},
    alone: {aloneUntil: '14:35'},
    connected: {},
};

describe('resolveCallStatus', () => {
    it('reports the healthy state as a status rather than as nothing', () => {
        // The row is always drawn, so it must have something to say when all is well - otherwise it
        // appears and disappears mid-call and takes the stage's height with it.
        expect(resolveCallStatus(OK).kind).toBe('connected');
        expect(resolveCallStatus(OK).tone).toBe('ok');
    });

    it.each(Object.keys(TRIGGERS) as CallStatusKind[])('maps its own trigger to %s', kind => {
        expect(resolveCallStatus({...OK, ...TRIGGERS[kind]}).kind).toBe(kind);
    });

    it('shows only the worst condition when several are true at once', () => {
        // This is the whole point: pre-unification all three of these rendered as separate stacked
        // banners, and a failed connection is *why* the audio stalled.
        const everything: CallStatusInput = {
            rtcState: 'failed',
            stalledAudio: true,
            aloneUntil: '14:35',
        };

        expect(resolveCallStatus(everything).kind).toBe('failed');
    });

    it('ranks every pair of conditions consistently with the declared precedence', () => {
        const kinds = CALL_STATUS_PRECEDENCE;

        for (let worse = 0; worse < kinds.length; worse++) {
            for (let better = worse + 1; better < kinds.length; better++) {
                const both = {...OK, ...TRIGGERS[kinds[better]], ...TRIGGERS[kinds[worse]]};
                expect(resolveCallStatus(both).kind).toBe(kinds[worse]);
            }
        }
    });

    it('keeps failed and lost apart', () => {
        // Both are red, but only one of them is something we can promise to recover from.
        expect(resolveCallStatus({...OK, rtcState: 'failed'}).labelKey).toBe('CALL.STATUS.FAILED');
        expect(resolveCallStatus({...OK, rtcState: 'disconnected'}).labelKey).toBe('CALL.STATUS.LOST');
    });

    it('treats a brand-new peer connection as connecting, not as healthy', () => {
        expect(resolveCallStatus({...OK, rtcState: 'new'}).kind).toBe('connecting');
    });

    it('passes the deadline through for interpolation instead of baking it into a string', () => {
        const status = resolveCallStatus({...OK, aloneUntil: '14:35'});

        expect(status.detailKey).toBe('CALL.STATUS.ALONE_DETAIL');
        expect(status.detailParams).toEqual({time: '14:35'});
    });

    it('leaves the self-evident states without a detail line', () => {
        expect(resolveCallStatus(OK).detailKey).toBeNull();
        expect(resolveCallStatus({...OK, rtcState: 'connecting'}).detailKey).toBeNull();
    });

    it('builds keys the locale file actually has', () => {
        // `no-audio` is the one kind whose key is not just its name uppercased.
        expect(resolveCallStatus({...OK, stalledAudio: true}).labelKey).toBe('CALL.STATUS.NO_AUDIO');
        expect(resolveCallStatus({...OK, stalledAudio: true}).detailKey).toBe('CALL.STATUS.NO_AUDIO_DETAIL');
    });

    it.each(Object.keys(TRIGGERS) as CallStatusKind[])('resolves %s to keys that exist in en.json', kind => {
        // These keys are assembled from the kind at runtime, so no template mentions them and the
        // static key sweep in i18n-keys.spec.ts cannot see them. Without this, renaming one leaves
        // the status row rendering the literal string "CALL.STATUS.WHATEVER" at the user.
        const status = resolveCallStatus({...OK, ...TRIGGERS[kind]});
        const strings = en as Record<string, string>;

        expect(strings[status.labelKey], `missing ${status.labelKey}`).toBeTruthy();
        if (status.detailKey) expect(strings[status.detailKey], `missing ${status.detailKey}`).toBeTruthy();
    });

    it('gives the alone detail a slot for the time to land in', () => {
        const status = resolveCallStatus({...OK, aloneUntil: '14:35'});

        expect((en as Record<string, string>)[status.detailKey!]).toContain('{{ time }}');
    });
});
