/**
 * What a call surface says about itself, as one condition rather than a pile of banners.
 *
 * <p>Both call views used to render every condition they knew about as its own full-width strip
 * stacked above the video: RTC state, then the alone-timeout notice, then the stalled-audio
 * warning. Three could be on screen at once, two of them amber, each one shoving the stage further
 * down mid-call. They are not independent facts - a connection that has failed is the reason the
 * audio stalled, and reporting both says nothing the first line did not.</p>
 *
 * <p>So they are ranked and only the worst one is shown. The order is by what the user can act on:
 * a dead connection first, then one still being established, then a fault that affects some
 * participants, then a timer that has not run out yet.</p>
 */

/** Worst first. The index in this array *is* the precedence. */
const PRECEDENCE = ['failed', 'lost', 'connecting', 'no-audio', 'alone', 'connected'] as const;

export type CallStatusKind = typeof PRECEDENCE[number];

/** Drives colour and the pulse. `ok` is the resting state and never pulses. */
export type CallStatusTone = 'ok' | 'warn' | 'error';

export interface CallStatusInput {
    /** `RTCPeerConnection.connectionState`, or whatever the owning service reports as one. */
    rtcState: string;
    /** At least one remote participant is past the audio grace window - see audio-wait.ts. */
    stalledAudio: boolean;
    /**
     * Wall-clock time the server will end the call at because this client is the last one in it,
     * already formatted for display. Null when no countdown is running.
     */
    aloneUntil: string | null;
}

export interface CallStatus {
    kind: CallStatusKind;
    tone: CallStatusTone;
    /** Translation key for the short label beside the dot. */
    labelKey: string;
    /** Translation key for the explanation, or null when the label already says it. */
    detailKey: string | null;
    /** Interpolation parameters for {@link detailKey}. */
    detailParams: Record<string, string> | null;
}

const TONES: Record<CallStatusKind, CallStatusTone> = {
    failed: 'error',
    lost: 'error',
    connecting: 'warn',
    'no-audio': 'warn',
    alone: 'warn',
    connected: 'ok',
};

/**
 * Picks the one condition worth reporting.
 *
 * <p>Pure and total: every input maps to exactly one status, and `connected` is the floor rather
 * than an absence, so the status row is always drawn at the same height and never appears or
 * disappears under the user mid-call.</p>
 */
export function resolveCallStatus(input: CallStatusInput): CallStatus {
    const kind = resolveKind(input);
    return {
        kind,
        tone: TONES[kind],
        labelKey: `CALL.STATUS.${labelSuffix(kind)}`,
        detailKey: detailKeyOf(kind),
        detailParams: kind === 'alone' && input.aloneUntil ? {time: input.aloneUntil} : null,
    };
}

/** True when this status should be announced to assistive tech the moment it appears. */
export function isCallStatusAlarming(status: CallStatus): boolean {
    return status.tone !== 'ok';
}

function resolveKind(input: CallStatusInput): CallStatusKind {
    // `failed` is terminal and `disconnected` is not, so they are separate lines even though both
    // are red - "attempting to reconnect" is a promise we can only keep for one of them.
    if (input.rtcState === 'failed') return 'failed';
    if (input.rtcState === 'disconnected') return 'lost';
    if (input.rtcState === 'new' || input.rtcState === 'connecting') return 'connecting';
    if (input.stalledAudio) return 'no-audio';
    if (input.aloneUntil) return 'alone';
    return 'connected';
}

function labelSuffix(kind: CallStatusKind): string {
    return kind.toUpperCase().replace('-', '_');
}

function detailKeyOf(kind: CallStatusKind): string | null {
    // `connected` and `connecting` are self-explanatory; the rest need a sentence saying what to do.
    if (kind === 'connected' || kind === 'connecting') return null;
    return `CALL.STATUS.${labelSuffix(kind)}_DETAIL`;
}

/** Exported for the spec - asserting on the real ordering beats restating it in the test. */
export const CALL_STATUS_PRECEDENCE: readonly CallStatusKind[] = PRECEDENCE;
