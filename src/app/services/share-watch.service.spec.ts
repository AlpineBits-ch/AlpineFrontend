import {TestBed} from '@angular/core/testing';
import {of, Subject, throwError} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ShareWatchService, WatchScope} from './share-watch.service';
import {ShareViewersDto} from '../dtos/response/share-viewers.dto';
import {GuildVoiceService} from './guild-voice.service';
import {VoiceService} from './voice.service';
import {GuildWebsocketService} from './guild-websocket.service';
import {VoiceWebsocketService} from './voice-websocket.service';

const CHANNEL_SCOPE: WatchScope = {kind: 'channel', guildId: 'guild-1', channelId: 'channel-1'};
const CALL_SCOPE: WatchScope = {kind: 'call', callId: 'call-1'};

function viewers(shareId: string, ids: string[], scope: 'channel' | 'call' = 'channel'): ShareViewersDto {
    return {
        ...(scope === 'channel' ? {channelId: 'channel-1'} : {callId: 'call-1'}),
        shareId,
        viewerCount: ids.length,
        viewerIds: ids,
    };
}

function setup(options: {watchFails?: boolean} = {}) {
    const guildEvents = new Subject<ShareViewersDto>();
    const callEvents = new Subject<ShareViewersDto>();

    const guildVoice = {
        watchShare: vi.fn((_g: string, _c: string, shareId: string) => options.watchFails
            ? throwError(() => new Error('offline'))
            : of(viewers(shareId, ['me']))),
        unwatchShare: vi.fn((_g: string, _c: string, shareId: string) => of(viewers(shareId, []))),
        getShareViewers: vi.fn(() => of({} as Record<string, string[]>)),
    };
    const voiceService = {
        watchShare: vi.fn((_id: string, shareId: string) => of(viewers(shareId, ['me'], 'call'))),
        unwatchShare: vi.fn((_id: string, shareId: string) => of(viewers(shareId, [], 'call'))),
        getShareViewers: vi.fn(() => of({} as Record<string, string[]>)),
    };

    TestBed.configureTestingModule({
        providers: [
            {provide: GuildVoiceService, useValue: guildVoice},
            {provide: VoiceService, useValue: voiceService},
            {provide: GuildWebsocketService, useValue: {shareViewersChangedObservable: guildEvents}},
            {provide: VoiceWebsocketService, useValue: {shareViewersChangedObservable: callEvents}},
        ],
    });

    const service = TestBed.inject(ShareWatchService);
    return {service, guildVoice, voiceService, guildEvents, callEvents};
}

describe('ShareWatchService', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        TestBed.resetTestingModule();
    });

    afterEach(() => vi.useRealTimers());

    it('announces a share that comes on screen', () => {
        const {service, guildVoice} = setup();

        service.setWatching(CHANNEL_SCOPE, ['share-1']);

        expect(guildVoice.watchShare).toHaveBeenCalledWith('guild-1', 'channel-1', 'share-1');
    });

    it('does not re-announce a share that was already on screen', () => {
        // Called on every render, so the diff is what keeps this off the network.
        const {service, guildVoice} = setup();

        service.setWatching(CHANNEL_SCOPE, ['share-1']);
        service.setWatching(CHANNEL_SCOPE, ['share-1']);

        expect(guildVoice.watchShare).toHaveBeenCalledTimes(1);
    });

    it('stops watching a share that left the screen', () => {
        // Maximising one stream stops the others being rendered, so their streamers should stop
        // counting this client.
        const {service, guildVoice} = setup();
        service.setWatching(CHANNEL_SCOPE, ['share-1', 'share-2']);

        service.setWatching(CHANNEL_SCOPE, ['share-1']);

        expect(guildVoice.unwatchShare).toHaveBeenCalledWith('guild-1', 'channel-1', 'share-2');
        expect(guildVoice.unwatchShare).toHaveBeenCalledTimes(1);
    });

    it('records the audience from the watch response', () => {
        const {service} = setup();

        service.setWatching(CHANNEL_SCOPE, ['share-1']);

        expect(service.viewerCount(CHANNEL_SCOPE, 'share-1')).toBe(1);
    });

    it('records the audience from the broadcast', () => {
        const {service, guildEvents} = setup();

        guildEvents.next(viewers('share-1', ['a', 'b', 'c']));

        expect(service.viewerCount(CHANNEL_SCOPE, 'share-1')).toBe(3);
    });

    it('reports nobody for a share it has heard nothing about', () => {
        const {service} = setup();

        expect(service.viewerCount(CHANNEL_SCOPE, 'unknown')).toBe(0);
    });

    it('keeps a channel and a call from overwriting each other', () => {
        // Share ids are drawn from different spaces and a client can be in both at once.
        const {service, guildEvents, callEvents} = setup();

        guildEvents.next(viewers('share-1', ['a']));
        callEvents.next(viewers('share-1', ['x', 'y'], 'call'));

        expect(service.viewerCount(CHANNEL_SCOPE, 'share-1')).toBe(1);
        expect(service.viewerCount(CALL_SCOPE, 'share-1')).toBe(2);
    });

    it('renews its claims before the server expires them', () => {
        // The claim lapses after 90s server-side, and a lapsed claim shows the streamer their
        // audience draining while everyone is still watching.
        const {service, guildVoice} = setup();
        service.setWatching(CHANNEL_SCOPE, ['share-1']);

        vi.advanceTimersByTime(46_000);

        expect(guildVoice.watchShare).toHaveBeenCalledTimes(2);
    });

    it('keeps renewing after a failed announcement', () => {
        // A watch refused because the roster had not caught up yet must not silently give up: the
        // claim stays local so the next beat retries.
        const {service, guildVoice} = setup({watchFails: true});
        service.setWatching(CHANNEL_SCOPE, ['share-1']);

        vi.advanceTimersByTime(46_000);

        expect(guildVoice.watchShare).toHaveBeenCalledTimes(2);
    });

    it('stops renewing once nothing is on screen', () => {
        const {service, guildVoice} = setup();
        service.setWatching(CHANNEL_SCOPE, ['share-1']);
        service.setWatching(CHANNEL_SCOPE, []);
        guildVoice.watchShare.mockClear();

        vi.advanceTimersByTime(200_000);

        expect(guildVoice.watchShare).not.toHaveBeenCalled();
    });

    it('drops its claims and its counts when a scope is torn down', () => {
        const {service, guildVoice} = setup();
        service.setWatching(CHANNEL_SCOPE, ['share-1']);

        service.clear(CHANNEL_SCOPE);

        expect(guildVoice.unwatchShare).toHaveBeenCalledWith('guild-1', 'channel-1', 'share-1');
        expect(service.viewerCount(CHANNEL_SCOPE, 'share-1')).toBe(0);
    });

    it('reads the current audience when asked to catch up', () => {
        const {service, guildVoice} = setup();
        guildVoice.getShareViewers.mockReturnValue(of({'share-1': ['a', 'b']}));

        service.refresh(CHANNEL_SCOPE);

        expect(service.viewerCount(CHANNEL_SCOPE, 'share-1')).toBe(2);
    });

    it('announces call shares through the call endpoints', () => {
        const {service, voiceService, guildVoice} = setup();

        service.setWatching(CALL_SCOPE, ['share-1']);

        expect(voiceService.watchShare).toHaveBeenCalledWith('call-1', 'share-1');
        expect(guildVoice.watchShare).not.toHaveBeenCalled();
    });
});
