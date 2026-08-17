/**
 * One shape for every per-stream statistics readout, in both directions and on both hosts.
 * Every numeric field must stay optional: a field a pipeline cannot produce renders as absent, never 0.
 */
export interface StreamStatsSnapshot {
    direction: 'inbound' | 'outbound';
    /** Which pipeline produced this. The panel branches on it to omit rows a pipeline cannot fill. */
    source: 'webview' | 'native';
    capturedAt: number;
    codec?: string;
    /** From the negotiated fmtp line: which H.264 profile and level survived negotiation. */
    profileLevelId?: string;
    transport?: StreamTransportStats;
    /** One entry per simulcast rid, or a single unnamed entry on a single-encoding stream. */
    layers: StreamLayerStats[];
    audio?: StreamAudioStats;
}

export interface StreamTransportStats {
    rttMs?: number;
    localCandidateType?: string;
    remoteCandidateType?: string;
    protocol?: string;
    availableOutgoingKbps?: number;
}

export interface StreamLayerStats {
    /** Absent on a single-encoding publication, which is the pre-simulcast case exactly. */
    rid?: string;
    ssrc?: number;
    mid?: string;
    width?: number;
    height?: number;
    fps?: number;
    /** Measured, from differentiated byte counters. */
    kbps?: number;
    /** What this rung was configured for. `kbps` against `targetKbps` is the finding. */
    targetKbps?: number;
    framesEncoded?: number;
    framesDecoded?: number;
    keyFrames?: number;
    framesDropped?: number;
    packets?: number;
    packetsLost?: number;
    nackCount?: number;
    pliCount?: number;
    firCount?: number;
    jitterMs?: number;
    qp?: number;
    /** e.g. MediaFoundation, openh264. Native outbound only. */
    encoder?: string;
}

/**
 * A layer plus the cumulative counter its rate is derived from. A mapper sees one report, so the
 * caller that owns the poll runs {@link kbpsBetween} over successive samples.
 */
export interface StreamLayerSample extends StreamLayerStats {
    /** Cumulative bytes this layer has sent. Outbound only. */
    bytesSent?: number;
    /** Cumulative bytes this layer has received. Inbound only. */
    bytesReceived?: number;
}

/** A snapshot whose layers still carry their cumulative counters, before a caller differentiates. */
export interface StreamStatsSample extends Omit<StreamStatsSnapshot, 'layers'> {
    layers: StreamLayerSample[];
}

export interface StreamAudioStats {
    kbps?: number;
    packets?: number;
    packetsLost?: number;
    packetsDropped?: number;
}

/** The slice of an `RTCStatsReport` these mappers need. A real report satisfies it. */
export interface StatsLike {
    forEach(callback: (stat: RTCStats) => void): void;
}

/**
 * Two cumulative byte counters and the seconds between them, as kbps.
 * Undefined, never 0, when there is no previous sample or no elapsed time.
 */
export function kbpsBetween(
    current: number | undefined,
    previous: number | undefined,
    dtSeconds: number,
): number | undefined {
    if (current === undefined || previous === undefined || dtSeconds <= 0) return undefined;
    return Math.max(0, Math.round(((current - previous) * 8) / dtSeconds / 1000));
}

/** Copy `value` onto `target[key]` only when it is a number. Keeps absent absent. */
function put<T extends object>(target: T, key: keyof T, value: unknown): void {
    if (typeof value === 'number') (target as Record<string, unknown>)[key as string] = value;
}

function profileLevelIdOf(fmtp: string | undefined): string | undefined {
    return fmtp
        ?.split(';')
        .find(p => p.startsWith('profile-level-id='))
        ?.split('=')[1];
}

/** The one candidate pair actually carrying media, plus the two candidates it names. */
function transportOf(stats: Map<string, RTCStats>): StreamTransportStats | undefined {
    let pair: Record<string, unknown> | undefined;
    for (const stat of stats.values()) {
        const s = stat as unknown as Record<string, unknown>;
        // A connection keeps every failed and in-progress pair in the report for its whole life.
        if (s['type'] === 'candidate-pair' && s['state'] === 'succeeded') {
            pair = s;
            break;
        }
    }
    if (!pair) return undefined;

    const local = stats.get(pair['localCandidateId'] as string) as unknown as
        Record<string, unknown> | undefined;
    const remote = stats.get(pair['remoteCandidateId'] as string) as unknown as
        Record<string, unknown> | undefined;

    const transport: StreamTransportStats = {};
    const rtt = pair['currentRoundTripTime'];
    if (typeof rtt === 'number') transport.rttMs = Math.round(rtt * 1000);
    if (typeof local?.['candidateType'] === 'string')
        transport.localCandidateType = local['candidateType'] as string;
    if (typeof remote?.['candidateType'] === 'string')
        transport.remoteCandidateType = remote['candidateType'] as string;
    if (typeof local?.['protocol'] === 'string') transport.protocol = local['protocol'] as string;
    const outgoing = pair['availableOutgoingBitrate'];
    if (typeof outgoing === 'number') transport.availableOutgoingKbps = Math.round(outgoing / 1000);

    return Object.keys(transport).length ? transport : undefined;
}

function indexOf(report: StatsLike): Map<string, RTCStats> {
    const byId = new Map<string, RTCStats>();
    report.forEach(stat => byId.set((stat as unknown as {id: string}).id, stat));
    return byId;
}

/**
 * The arriving half of one remote screen share, read off the report the RTC services already poll.
 * Null when no `inbound-rtp` stat carries that mid. The caller must differentiate `bytesReceived`.
 */
export function inboundStatsFor(report: StatsLike, mid: string): StreamStatsSample | null {
    const byId = indexOf(report);

    let rtp: Record<string, unknown> | undefined;
    for (const stat of byId.values()) {
        const s = stat as unknown as Record<string, unknown>;
        if (s['type'] === 'inbound-rtp' && s['kind'] === 'video' && s['mid'] === mid) {
            rtp = s;
            break;
        }
    }
    if (!rtp) return null;

    const layer: StreamLayerSample = {mid};
    put(layer, 'ssrc', rtp['ssrc']);
    put(layer, 'bytesReceived', rtp['bytesReceived']);
    put(layer, 'width', rtp['frameWidth']);
    put(layer, 'height', rtp['frameHeight']);
    put(layer, 'fps', rtp['framesPerSecond']);
    put(layer, 'framesDecoded', rtp['framesDecoded']);
    put(layer, 'keyFrames', rtp['keyFramesDecoded']);
    put(layer, 'framesDropped', rtp['framesDropped']);
    put(layer, 'packets', rtp['packetsReceived']);
    put(layer, 'packetsLost', rtp['packetsLost']);
    put(layer, 'nackCount', rtp['nackCount']);
    put(layer, 'pliCount', rtp['pliCount']);
    put(layer, 'firCount', rtp['firCount']);
    if (typeof rtp['jitter'] === 'number') layer.jitterMs = Math.round((rtp['jitter'] as number) * 1000);

    const snapshot: StreamStatsSample = {
        direction: 'inbound',
        source: 'webview',
        capturedAt: Date.now(),
        layers: [layer],
    };

    const codec = byId.get(rtp['codecId'] as string) as unknown as Record<string, unknown> | undefined;
    if (typeof codec?.['mimeType'] === 'string') snapshot.codec = codec['mimeType'] as string;
    const fmtp = profileLevelIdOf(codec?.['sdpFmtpLine'] as string | undefined);
    if (fmtp) snapshot.profileLevelId = fmtp;

    const transport = transportOf(byId);
    if (transport) snapshot.transport = transport;

    return snapshot;
}

/**
 * The outgoing half of a publication, read off a browser `getStats()` report. Web host only.
 * Layers come back ordered by rid, and `bytesSent` stays un-differentiated for the caller's poll.
 */
export function outboundStatsFromReport(report: StatsLike, mid: string): StreamStatsSample | null {
    const byId = indexOf(report);

    const rtps: Record<string, unknown>[] = [];
    const remoteBySsrc = new Map<number, Record<string, unknown>>();
    for (const stat of byId.values()) {
        const s = stat as unknown as Record<string, unknown>;
        if (s['type'] === 'outbound-rtp' && s['kind'] === 'video' && s['mid'] === mid) rtps.push(s);
        else if (s['type'] === 'remote-inbound-rtp' && typeof s['ssrc'] === 'number') {
            remoteBySsrc.set(s['ssrc'] as number, s);
        }
    }
    if (!rtps.length) return null;

    rtps.sort((a, b) => String(a['rid'] ?? '').localeCompare(String(b['rid'] ?? '')));

    let rttMs: number | undefined;
    const layers = rtps.map(rtp => {
        const layer: StreamLayerSample = {mid};
        if (typeof rtp['rid'] === 'string') layer.rid = rtp['rid'] as string;
        put(layer, 'ssrc', rtp['ssrc']);
        put(layer, 'bytesSent', rtp['bytesSent']);
        put(layer, 'width', rtp['frameWidth']);
        put(layer, 'height', rtp['frameHeight']);
        put(layer, 'fps', rtp['framesPerSecond']);
        put(layer, 'framesEncoded', rtp['framesEncoded']);
        put(layer, 'keyFrames', rtp['keyFramesEncoded']);
        put(layer, 'packets', rtp['packetsSent']);
        put(layer, 'nackCount', rtp['nackCount']);
        put(layer, 'pliCount', rtp['pliCount']);
        put(layer, 'firCount', rtp['firCount']);
        if (typeof rtp['encoderImplementation'] === 'string') {
            layer.encoder = rtp['encoderImplementation'] as string;
        }

        // qpSum is cumulative over framesEncoded, so the useful number is the average. The zero
        // guard matters: reporting qp 0 would read as perfect quality, not as nothing encoded.
        const qpSum = rtp['qpSum'];
        const encoded = rtp['framesEncoded'];
        if (typeof qpSum === 'number' && typeof encoded === 'number' && encoded > 0) {
            layer.qp = Math.round(qpSum / encoded);
        }

        // What the receiver reports back over RTCP. Its RTT is the publication's, not this layer's,
        // so it is lifted to transport.
        const remote = typeof rtp['ssrc'] === 'number' ? remoteBySsrc.get(rtp['ssrc'] as number) : undefined;
        if (remote) {
            put(layer, 'packetsLost', remote['packetsLost']);
            if (rttMs === undefined && typeof remote['roundTripTime'] === 'number') {
                rttMs = Math.round((remote['roundTripTime'] as number) * 1000);
            }
        }

        return layer;
    });

    const snapshot: StreamStatsSample = {
        direction: 'outbound',
        source: 'webview',
        capturedAt: Date.now(),
        layers,
    };

    const codec = byId.get(rtps[0]['codecId'] as string) as unknown as Record<string, unknown> | undefined;
    if (typeof codec?.['mimeType'] === 'string') snapshot.codec = codec['mimeType'] as string;
    const fmtp = profileLevelIdOf(codec?.['sdpFmtpLine'] as string | undefined);
    if (fmtp) snapshot.profileLevelId = fmtp;

    const transport = transportOf(byId) ?? (rttMs === undefined ? undefined : {});
    if (transport) {
        if (transport.rttMs === undefined && rttMs !== undefined) transport.rttMs = rttMs;
        snapshot.transport = transport;
    }

    return snapshot;
}
