import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {of, Subject, throwError} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {EntitlementStore, MY_ENTITLEMENTS} from './entitlement.store';
import {environment} from '../../environments/environment';
import {ApiConfigService} from '../services/api-config.service';
import {EntitlementService} from '../services/entitlement.service';
import {GuildService} from '../services/guild.service';
import {ProfileService} from '../services/profile.service';
import {RealtimeConnectionService} from '../services/realtime-connection.service';
import {EntitlementSnapshotDto, GuildFeatureResolutionDto} from '../dtos/response/entitlement.dto';

function snapshot(over: Partial<EntitlementSnapshotDto> = {}): EntitlementSnapshotDto {
    return {
        licenseMode: 'hosted',
        upgradesAvailable: true,
        vocabularyVersion: 1,
        subject: {kind: 'user', id: 'user-1'},
        resolvedAt: '2026-08-14T10:00:00Z',
        version: 0,
        ttlSeconds: 60,
        entitlements: {
            'user.upload_max_bytes': {kind: 'numeric', value: 26214400, unlimited: false},
        },
        ladders: {},
        remedy: 'upgrade_user',
        actorCanRemedy: true,
        ...over,
    };
}

function guildSnapshot(id: string, over: Partial<EntitlementSnapshotDto> = {}): EntitlementSnapshotDto {
    return snapshot({
        subject: {kind: 'guild', id},
        entitlements: {'storage.upload_max_bytes': {kind: 'numeric', value: 8388608, unlimited: false}},
        ...over,
    });
}

function resolution(over: Partial<GuildFeatureResolutionDto> = {}): GuildFeatureResolutionDto {
    return {
        chosen: ['Forums', 'Events', 'Wiki'],
        includedByPlan: ['Events', 'Wiki'],
        withheldByPlan: ['Forums'],
        effective: ['Events', 'Wiki'],
        ...over,
    };
}

function setup() {
    const baseUrl = signal('https://api.test.example');
    const ownProfile = signal<{userId: string} | undefined>({userId: 'user-1'});
    const service = {
        getMine: vi.fn(() => of(snapshot())),
        getForGuild: vi.fn((id: string) => of(guildSnapshot(id))),
    };
    const guilds = {
        getGuildFeatures: vi.fn((_id: string) => of(resolution())),
    };
    const handlers = new Map<string, (payload: unknown) => void>();

    TestBed.configureTestingModule({
        providers: [
            {provide: ApiConfigService, useValue: {baseUrl}},
            {provide: EntitlementService, useValue: service},
            {provide: GuildService, useValue: guilds},
            {provide: ProfileService, useValue: {ownProfile}},
            {
                provide: RealtimeConnectionService,
                useValue: {on: (event: string, handler: (p: unknown) => void) => handlers.set(event, handler)},
            },
        ],
    });

    return {store: TestBed.inject(EntitlementStore), service, guilds, baseUrl, ownProfile, handlers};
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('reading a set', () => {
    it('holds what the server answered', () => {
        const {store} = setup();

        store.ensureLoaded(MY_ENTITLEMENTS);

        expect(store.snapshot(MY_ENTITLEMENTS)?.licenseMode).toBe('hosted');
        expect(store.value(MY_ENTITLEMENTS, 'user.upload_max_bytes'))
            .toEqual({kind: 'numeric', value: 26214400, unlimited: false});
    });

    it('reads one guild set through its own endpoint', () => {
        const {store, service} = setup();

        store.ensureLoaded({kind: 'guild', id: 'guild-1'});

        expect(service.getForGuild).toHaveBeenCalledWith('guild-1');
        expect(store.snapshot({kind: 'guild', id: 'guild-1'})?.subject.id).toBe('guild-1');
    });

    it('does not fire a second request while the first is in flight', () => {
        const {store, service} = setup();
        service.getMine.mockReturnValue(new Subject());

        store.ensureLoaded(MY_ENTITLEMENTS);
        store.ensureLoaded(MY_ENTITLEMENTS);

        expect(service.getMine).toHaveBeenCalledTimes(1);
    });

    it('survives a failed read without holding a half-written set', () => {
        const {store, service} = setup();
        service.getMine.mockReturnValue(throwError(() => new Error('offline')));

        store.ensureLoaded(MY_ENTITLEMENTS);

        expect(store.snapshot(MY_ENTITLEMENTS)).toBeNull();
        // The loading flag has to clear, or the retry below is blocked forever.
        service.getMine.mockReturnValue(of(snapshot()));
        store.ensureLoaded(MY_ENTITLEMENTS);
        expect(store.snapshot(MY_ENTITLEMENTS)).not.toBeNull();
    });
});

/**
 * Caching longer than the server said defeats the self-healing its own cache backstop exists to
 * provide: an invalidation the server dropped and then repaired would stay broken here.
 */
describe('the TTL', () => {
    it('serves a set inside the window without asking again', () => {
        const {store, service} = setup();
        store.ensureLoaded(MY_ENTITLEMENTS);

        vi.advanceTimersByTime(59_000);
        store.ensureLoaded(MY_ENTITLEMENTS);

        expect(service.getMine).toHaveBeenCalledTimes(1);
        expect(store.snapshot(MY_ENTITLEMENTS)).not.toBeNull();
    });

    it('stops answering from a set older than the server allowed', () => {
        const {store, service} = setup();
        store.ensureLoaded(MY_ENTITLEMENTS);

        vi.advanceTimersByTime(61_000);

        expect(store.snapshot(MY_ENTITLEMENTS)).toBeNull();
        store.ensureLoaded(MY_ENTITLEMENTS);
        expect(service.getMine).toHaveBeenCalledTimes(2);
    });

    it('honours a ttl the server shortened', () => {
        const {store, service} = setup();
        service.getMine.mockReturnValue(of(snapshot({ttlSeconds: 5})));
        store.ensureLoaded(MY_ENTITLEMENTS);

        vi.advanceTimersByTime(6_000);

        expect(store.snapshot(MY_ENTITLEMENTS)).toBeNull();
    });
});

/**
 * The cache key is `(baseUrl, accountId, subjectKind, subjectId)`. Anything less shows one account's
 * limits to another: this client switches instance and account at runtime without a restart.
 */
describe('the cache key', () => {
    it('does not serve one account set to another', () => {
        const {store, ownProfile} = setup();
        store.ensureLoaded(MY_ENTITLEMENTS);

        ownProfile.set({userId: 'user-2'});

        expect(store.snapshot(MY_ENTITLEMENTS)).toBeNull();
    });

    it('does not serve one instance set on another', () => {
        const {store, baseUrl} = setup();
        store.ensureLoaded(MY_ENTITLEMENTS);

        baseUrl.set('https://selfhosted.example');

        expect(store.snapshot(MY_ENTITLEMENTS)).toBeNull();
    });

    it('keeps two guilds apart', () => {
        const {store} = setup();

        store.ensureLoaded({kind: 'guild', id: 'guild-1'});

        expect(store.snapshot({kind: 'guild', id: 'guild-2'})).toBeNull();
    });
});

describe('a response that arrived after the world moved', () => {
    /** Without the echo a late response is filed against whatever the user has since switched to. */
    it('discards a response about a different subject', () => {
        const {store, service} = setup();
        service.getForGuild.mockReturnValue(of(guildSnapshot('guild-9')));

        store.ensureLoaded({kind: 'guild', id: 'guild-1'});

        expect(store.snapshot({kind: 'guild', id: 'guild-1'})).toBeNull();
    });

    /**
     * Version is zero on every instance until Billing owns a counter. Comparing it is still correct,
     * and it starts working the day it moves.
     */
    it('never serves a set older than the one it held', () => {
        const {store, service} = setup();
        service.getMine.mockReturnValue(of(snapshot({version: 7})));
        store.ensureLoaded(MY_ENTITLEMENTS);

        store.invalidate(MY_ENTITLEMENTS);
        service.getMine.mockReturnValue(of(snapshot({version: 6})));
        store.ensureLoaded(MY_ENTITLEMENTS);

        // Not "still answers 7": the invalidation said the held set may no longer be trusted. What
        // matters is that the older one did not take its place - had it been written it would be
        // freshly fetched and served here.
        expect(store.snapshot(MY_ENTITLEMENTS)).toBeNull();
    });

    /** A discarded response is still a response, and the entry cannot stay marked in flight. */
    it('is readable again after discarding one', () => {
        const {store, service} = setup();
        service.getForGuild.mockReturnValue(of(guildSnapshot('guild-9')));
        store.ensureLoaded({kind: 'guild', id: 'guild-1'});

        service.getForGuild.mockReturnValue(of(guildSnapshot('guild-1')));
        store.ensureLoaded({kind: 'guild', id: 'guild-1'});

        expect(store.snapshot({kind: 'guild', id: 'guild-1'})?.subject.id).toBe('guild-1');
    });

    it('takes a newer one', () => {
        const {store, service} = setup();
        service.getMine.mockReturnValue(of(snapshot({version: 7})));
        store.ensureLoaded(MY_ENTITLEMENTS);

        store.invalidate(MY_ENTITLEMENTS);
        service.getMine.mockReturnValue(of(snapshot({version: 8})));
        store.ensureLoaded(MY_ENTITLEMENTS);

        expect(store.snapshot(MY_ENTITLEMENTS)?.version).toBe(8);
    });
});

/**
 * Hidden, not disabled. A self-hoster shown a paywall has hit one for a product nobody is charging
 * them for, and a hosted instance whose billing is not configured yet reads the same way.
 */
describe('whether to draw an upgrade at all', () => {
    it('is no until something has been read', () => {
        const {store} = setup();

        expect(store.upgradesAvailable()).toBe(false);
        expect(store.licenseMode()).toBeNull();
    });

    it('follows the instance', () => {
        const {store, service} = setup();
        service.getMine.mockReturnValue(of(snapshot({licenseMode: 'selfhost', upgradesAvailable: false})));

        store.ensureLoaded(MY_ENTITLEMENTS);

        expect(store.upgradesAvailable()).toBe(false);
        expect(store.licenseMode()).toBe('selfhost');
    });

    /** Hosted and not selling anything yet is a supported state, and is not the same as selfhost. */
    it('is no on a hosted instance whose billing is not configured', () => {
        const {store, service} = setup();
        service.getMine.mockReturnValue(of(snapshot({licenseMode: 'hosted', upgradesAvailable: false})));

        store.ensureLoaded(MY_ENTITLEMENTS);

        expect(store.licenseMode()).toBe('hosted');
        expect(store.upgradesAvailable()).toBe(false);
    });

    it('is yes when the instance sells something', () => {
        const {store} = setup();

        store.ensureLoaded(MY_ENTITLEMENTS);

        expect(store.upgradesAvailable()).toBe(true);
    });
});

describe('the upload ceiling', () => {
    it('is the account own limit outside a guild', () => {
        const {store} = setup();
        store.ensureLoaded(MY_ENTITLEMENTS);

        expect(store.uploadCeilingBytes(null)).toBe(26214400);
    });

    /** Paired: what the caller actually gets is the lower of the two sides. */
    it('is the lower of the two sides inside a guild', () => {
        const {store} = setup();
        store.ensureLoaded(MY_ENTITLEMENTS);
        store.ensureLoaded({kind: 'guild', id: 'guild-1'});

        expect(store.uploadCeilingBytes('guild-1')).toBe(8388608);
    });

    it('enforces nothing when neither side is held', () => {
        const {store} = setup();

        expect(store.uploadCeilingBytes('guild-1')).toBeNull();
    });

    it('enforces nothing against an unlimited account', () => {
        const {store, service} = setup();
        service.getMine.mockReturnValue(of(snapshot({
            entitlements: {'user.upload_max_bytes': {kind: 'numeric', value: null, unlimited: true}},
        })));
        store.ensureLoaded(MY_ENTITLEMENTS);

        expect(store.uploadCeilingBytes(null)).toBeNull();
    });
});

/**
 * The ladder, which is what turns a rung name on a voice snapshot into a clamp on a picker.
 *
 * <p>It is the instance's definition of what each rung permits rather than a per-subject grant -
 * only the rung <i>on</i> it differs by subject - which is why either held snapshot answers it, and
 * why nothing in the app is allowed to keep a copy of one.</p>
 */
describe('a published ladder', () => {
    const VIDEO = [
        {rung: 'none', rank: 0, maxHeight: 0, maxFramerate: 0},
        {rung: '720p30', rank: 2, maxHeight: 720, maxFramerate: 30},
    ];

    it('comes from the caller own set when no guild is named', () => {
        const {store, service} = setup();
        service.getMine.mockReturnValue(of(snapshot({ladders: {video_quality: VIDEO}})));
        store.ensureLoaded(MY_ENTITLEMENTS);

        expect(store.ladder('video_quality')).toEqual(VIDEO);
    });

    it('prefers the guild copy on a guild screen, and falls back to the account one', () => {
        const {store, service} = setup();
        service.getMine.mockReturnValue(of(snapshot({ladders: {video_quality: VIDEO}})));
        service.getForGuild.mockImplementation((id: string) =>
            of(guildSnapshot(id, {ladders: {video_quality: [{rung: 'none', rank: 0}]}})));
        store.ensureLoaded(MY_ENTITLEMENTS);
        store.ensureLoaded({kind: 'guild', id: 'guild-1'});

        expect(store.ladder('video_quality', 'guild-1')).toEqual([{rung: 'none', rank: 0}]);
        // Nothing held for this guild, so the account's answers rather than nothing at all.
        expect(store.ladder('video_quality', 'guild-9')).toEqual(VIDEO);
    });

    /** Negative: nothing held, and a ladder nobody published. Both clamp nothing. */
    it('is undefined when nothing published one', () => {
        const {store} = setup();
        expect(store.ladder('video_quality')).toBeUndefined();

        store.ensureLoaded(MY_ENTITLEMENTS);
        expect(store.ladder('video_quality')).toBeUndefined();
        expect(store.ladder('ladder_of_the_future')).toBeUndefined();
    });
});

/**
 * An envelope, not the values. A guild plan change fans out to every online member and delivery is
 * unordered, so a pushed value can arrive stale and overwrite a newer one; a version plus a refetch
 * is monotonic.
 */
describe('the entitlements.Changed push', () => {
    it('refetches the guild it names', () => {
        const {store, service, handlers} = setup();
        store.ensureLoaded({kind: 'guild', id: 'guild-1'});
        service.getForGuild.mockClear();

        handlers.get('entitlements.Changed')!(
            {subjectKind: 'guild', subjectId: 'guild-1', version: 1, changedKeys: []});

        expect(service.getForGuild).toHaveBeenCalledWith('guild-1');
    });

    it('refetches the caller own set for a user change', () => {
        const {store, service, handlers} = setup();
        store.ensureLoaded(MY_ENTITLEMENTS);
        service.getMine.mockClear();

        handlers.get('entitlements.Changed')!(
            {subjectKind: 'user', subjectId: 'user-1', version: 1});

        expect(service.getMine).toHaveBeenCalled();
    });

    /** Nothing held for that subject is nothing to refetch. */
    it('does not pull a set nobody has open', () => {
        const {service, handlers} = setup();

        handlers.get('entitlements.Changed')!(
            {subjectKind: 'guild', subjectId: 'guild-7', version: 1});

        expect(service.getForGuild).not.toHaveBeenCalled();
    });

    /**
     * A plan change moves the ceilings and the module resolution together. Refetching only the
     * numbers leaves a guild that just bought Forums being told Forums is not in its plan.
     */
    it('refreshes the module resolution it holds for that guild', () => {
        const {store, guilds, handlers} = setup();
        store.ensureFeaturesLoaded('guild-1');
        guilds.getGuildFeatures.mockClear();

        handlers.get('entitlements.Changed')!(
            {subjectKind: 'guild', subjectId: 'guild-1', version: 1, changedKeys: []});

        expect(guilds.getGuildFeatures).toHaveBeenCalledWith('guild-1');
    });

    it('does not pull a resolution nobody has open', () => {
        const {guilds, handlers} = setup();

        handlers.get('entitlements.Changed')!(
            {subjectKind: 'guild', subjectId: 'guild-7', version: 1});

        expect(guilds.getGuildFeatures).not.toHaveBeenCalled();
    });
});

/**
 * The one commercial fact a member owns about themselves. Everything else on the payload is a
 * ceiling, and none of it answers "what am I on".
 */
describe('the plan', () => {
    it('reads the plan the server named', () => {
        const {store, service} = setup();
        service.getMine.mockReturnValue(of(snapshot({
            plan: {name: 'plus', displayName: 'Venta Plus', version: 2},
        })));

        store.ensureLoaded(MY_ENTITLEMENTS);

        expect(store.myPlan()).toEqual({name: 'plus', displayName: 'Venta Plus', version: 2});
        expect(store.plan(MY_ENTITLEMENTS)?.displayName).toBe('Venta Plus');
    });

    /**
     * Absent is a real state, not a gap: an instance with no plans configured resolves every key
     * to its catalogue default and a self-hosted one resolves everything to maximum. Substituting
     * a "Free" here would put a tier boundary on the screen of somebody nobody is charging.
     */
    it('invents nothing when the server named no plan', () => {
        const {store} = setup();
        store.ensureLoaded(MY_ENTITLEMENTS);

        expect(store.myPlan()).toBeNull();
    });

    it('is null before anything has been read', () => {
        const {store} = setup();

        expect(store.myPlan()).toBeNull();
        expect(store.plan({kind: 'guild', id: 'guild-1'})).toBeNull();
    });

    /** The version a subject is pinned to, which is not necessarily the newest one on sale. */
    it('keeps a pinned version rather than dropping it', () => {
        const {store, service} = setup();
        service.getForGuild.mockReturnValue(of(guildSnapshot('guild-1', {
            plan: {name: 'plus', displayName: 'Venta Plus', version: 2},
        })));

        store.ensureLoaded({kind: 'guild', id: 'guild-1'});

        expect(store.plan({kind: 'guild', id: 'guild-1'})?.version).toBe(2);
    });

    /** Absent is not version zero. A subject on an unversioned plan has no version to report. */
    it('reports no version for a plan the instance does not version', () => {
        const {store, service} = setup();
        service.getMine.mockReturnValue(of(snapshot({
            plan: {name: 'plus', displayName: 'Venta Plus'},
        })));

        store.ensureLoaded(MY_ENTITLEMENTS);

        expect(store.myPlan()?.version).toBeUndefined();
    });
});

/**
 * A key compiled into a release belongs to one Stripe account, and this client is pointed at
 * arbitrary instances at runtime - so a bundled key aims every self-hoster's checkout at whoever
 * produced the build.
 */
describe('the Stripe publishable key', () => {
    it('prefers the instance own key', () => {
        const {store, service} = setup();
        service.getMine.mockReturnValue(of(snapshot({stripePublishableKey: 'pk_live_theirs'})));

        store.ensureLoaded(MY_ENTITLEMENTS);

        expect(store.stripePublishableKey()).toBe('pk_live_theirs');
    });

    /** Absent is the normal case and is not an error. */
    it('falls back to the bundled key when the instance sends none', () => {
        const {store} = setup();
        store.ensureLoaded(MY_ENTITLEMENTS);

        expect(store.stripePublishableKey()).toBe(environment.stripePublishableKey);
    });

    /** A blank key initialises nothing, which is a worse answer than the fallback. */
    it('treats a blank key as none at all', () => {
        const {store, service} = setup();
        service.getMine.mockReturnValue(of(snapshot({stripePublishableKey: '   '})));

        store.ensureLoaded(MY_ENTITLEMENTS);

        expect(store.stripePublishableKey()).toBe(environment.stripePublishableKey);
    });
});

/**
 * Three lists and the result, because a module can be unusable for three reasons and only one of
 * them is an upgrade. Deriving the withheld list from what is effective is what the contract exists
 * to prevent.
 */
describe('the guild module resolution', () => {
    it('reads one guild resolution through its own route', () => {
        const {store, guilds} = setup();

        store.ensureFeaturesLoaded('guild-1');

        expect(guilds.getGuildFeatures).toHaveBeenCalledWith('guild-1');
        expect(store.features('guild-1')?.withheldByPlan).toEqual(['Forums']);
    });

    it('tells a withheld module from one the owner turned off', () => {
        const {store} = setup();
        store.ensureFeaturesLoaded('guild-1');

        expect(store.moduleStanding('guild-1', 'Forums')).toBe('withheld');
        expect(store.moduleStanding('guild-1', 'Tickets')).toBe('off');
        expect(store.moduleStanding('guild-1', 'Events')).toBe('on');
    });

    /** Absent is "not loaded", never "no modules" - the resolution is not on the guild list. */
    it('says nothing at all about a guild it has not read', () => {
        const {store} = setup();

        expect(store.features('guild-9')).toBeNull();
        expect(store.moduleStanding('guild-9', 'Forums')).toBe('unknown');
    });

    it('does not ask twice for a resolution it holds', () => {
        const {store, guilds} = setup();

        store.ensureFeaturesLoaded('guild-1');
        store.ensureFeaturesLoaded('guild-1');

        expect(guilds.getGuildFeatures).toHaveBeenCalledTimes(1);
    });

    /** A failed read proves nothing, and an empty resolution would read as "every module is off". */
    it('leaves the standing unknown when the read fails', () => {
        const {store, guilds} = setup();
        guilds.getGuildFeatures.mockReturnValue(throwError(() => new Error('offline')));

        store.ensureFeaturesLoaded('guild-1');

        expect(store.moduleStanding('guild-1', 'Forums')).toBe('unknown');
        // The loading flag has to clear, or the retry below is blocked forever.
        guilds.getGuildFeatures.mockReturnValue(of(resolution()));
        store.ensureFeaturesLoaded('guild-1');
        expect(store.moduleStanding('guild-1', 'Forums')).toBe('withheld');
    });

    it('takes a resolution that rode a single-guild read', () => {
        const {store, guilds} = setup();

        store.putFeatures('guild-1', resolution({withheldByPlan: ['Wiki'], effective: ['Events']}));

        expect(store.moduleStanding('guild-1', 'Wiki')).toBe('withheld');
        expect(guilds.getGuildFeatures).not.toHaveBeenCalled();
    });

    it('keeps two guilds apart', () => {
        const {store} = setup();
        store.ensureFeaturesLoaded('guild-1');

        expect(store.features('guild-2')).toBeNull();
    });

    /** One account's plan must never answer for another's, resolution included. */
    it('does not serve one account resolution to the next', () => {
        const {store, ownProfile} = setup();
        store.ensureFeaturesLoaded('guild-1');

        ownProfile.set({userId: 'user-2'});

        expect(store.features('guild-1')).toBeNull();
    });
});
