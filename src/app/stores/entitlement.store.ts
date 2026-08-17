import {computed, inject} from '@angular/core';
import {patchState, signalStore, withComputed, withHooks, withMethods, withState} from '@ngrx/signals';
import {environment} from '../../environments/environment';
import {ApiConfigService} from '../services/api-config.service';
import {EntitlementService} from '../services/entitlement.service';
import {ProfileService} from '../services/profile.service';
import {RealtimeConnectionService} from '../services/realtime-connection.service';
import {GuildService} from '../services/guild.service';
import {
    ENTITLEMENT_KEYS,
    EntitlementPlanDto,
    EntitlementRungDto,
    EntitlementSnapshotDto,
    EntitlementsChangedDto,
    EntitlementSubjectKind,
    EntitlementValueDto,
    GuildFeatureResolutionDto,
    moduleStandingOf,
    numericCeiling,
} from '../dtos/response/entitlement.dto';

/**
 * The cache key, and the two ways to get it wrong.
 *
 * <p>`(baseUrl, accountId, subjectKind, subjectId)`. Anything less shows one account's limits to
 * another: this client switches instance and account at runtime without a process restart, so a
 * cache keyed on subject id alone survives both switches and answers with the wrong plan.</p>
 *
 * <p>An account that has not been read yet keys as `anon`, which is a miss rather than a wrong
 * answer - the entry it writes is never read back once the profile lands and the key changes.</p>
 */
function cacheKey(baseUrl: string, accountId: string, kind: EntitlementSubjectKind, id: string): string {
    return `${baseUrl}|${accountId}|${kind}|${id}`;
}

interface EntitlementEntry {
    snapshot: EntitlementSnapshotDto | null;
    fetchedAt: number;
    loading: boolean;
    requestId: number;
}

/**
 * One guild's module resolution.
 *
 * <p>No `fetchedAt`, deliberately: unlike a ceiling this has no server-stated TTL, and the two
 * things that can change it - an owner toggling a module, a plan moving - both announce themselves.
 * A held entry is dropped by {@link EntitlementStore.invalidate} on the `entitlements.Changed` push
 * and re-read by whichever module screen is open, so an expiry clock would only add requests
 * nothing was waiting for.</p>
 */
interface FeatureEntry {
    resolution: GuildFeatureResolutionDto | null;
    loading: boolean;
    requestId: number;
}

interface EntitlementState {
    byCacheKey: Record<string, EntitlementEntry>;
    featuresByCacheKey: Record<string, FeatureEntry>;
}

/** The subject a caller is asking about. `me` needs no id; a guild is its own subject. */
export type EntitlementSubjectRef = {kind: 'user'; id: 'me'} | {kind: 'guild'; id: string};

export const MY_ENTITLEMENTS: EntitlementSubjectRef = {kind: 'user', id: 'me'};

/**
 * Resolved entitlement ceilings, cached for exactly as long as the server says.
 *
 * <p><b>Nothing here is ever persisted.</b> A plan read from disk at cold start would show the
 * wrong limits before the first fetch lands, and "your server was downgraded" is not a sentence to
 * render by accident. The guild layout cache is the precedent for what is safe to persist; this is
 * not that.</p>
 *
 * <p>Ceilings only. How much of one has been used is a separate payload with opposite caching
 * properties, and the server does not count consumption yet - so there is no "47 of 50" here, and
 * building one against a denominator alone would be worse than the bare count it would replace.</p>
 */
export const EntitlementStore = signalStore(
    {providedIn: 'root'},
    withState<EntitlementState>({byCacheKey: {}, featuresByCacheKey: {}}),

    withMethods(
        (
            store,
            entitlements = inject(EntitlementService),
            guilds = inject(GuildService),
            apiConfig = inject(ApiConfigService),
            profile = inject(ProfileService),
        ) => {
            const keyFor = (subject: EntitlementSubjectRef): string =>
                cacheKey(
                    apiConfig.baseUrl(),
                    profile.ownProfile()?.userId ?? 'anon',
                    subject.kind,
                    subject.id,
                );

            /**
             * Fresh means "inside the TTL the server stated". Never longer: caching past it defeats the
             * self-healing the server's own cache backstop exists to provide, because an invalidation
             * the server dropped and then repaired would stay broken here.
             */
            const fresh = (entry: EntitlementEntry | undefined): EntitlementSnapshotDto | null => {
                if (!entry?.snapshot) return null;
                const ttlMs = Math.max(0, entry.snapshot.ttlSeconds) * 1000;
                return Date.now() - entry.fetchedAt < ttlMs ? entry.snapshot : null;
            };

            const write = (key: string, entry: EntitlementEntry): void =>
                patchState(store, {byCacheKey: {...store.byCacheKey(), [key]: entry}});

            const writeFeatures = (key: string, entry: FeatureEntry): void =>
                patchState(store, {featuresByCacheKey: {...store.featuresByCacheKey(), [key]: entry}});

            const snapshotOf = (subject: EntitlementSubjectRef): EntitlementSnapshotDto | null =>
                fresh(store.byCacheKey()[keyFor(subject)]);

            const featuresOf = (guildId: string): GuildFeatureResolutionDto | null =>
                store.featuresByCacheKey()[keyFor({kind: 'guild', id: guildId})]?.resolution ?? null;

            const valueOf = (subject: EntitlementSubjectRef, key: string): EntitlementValueDto | undefined =>
                snapshotOf(subject)?.entitlements[key];

            return {
                /** The snapshot, or null when there is none or it has aged past its TTL. */
                snapshot: snapshotOf,

                /** One value out of a subject's set, or undefined when the set is not held. */
                value: valueOf,

                /**
                 * Which plan a subject is on, or null when nothing says.
                 *
                 * <p>Null covers both "no set is held" and "the server sent no plan", and a caller has
                 * to treat them the same: neither is a licence to name a tier. An instance with no
                 * plans configured, and every self-hosted one, resolves every key to its default and
                 * has no plan to name - substituting a "Free" there would put a tier boundary on the
                 * screen of somebody nobody is charging.</p>
                 */
                plan: (subject: EntitlementSubjectRef): EntitlementPlanDto | null =>
                    snapshotOf(subject)?.plan ?? null,

                /**
                 * One published ladder, lowest rung first, or undefined when none is held.
                 *
                 * <p>The guild's copy first and the caller's own as the fallback, because the two are
                 * the same ladder: a ladder is the instance's definition of what each rung permits, not
                 * a per-subject grant, and only the rung *on* it differs by subject. Reading either is
                 * therefore correct, and reading the guild's first is only about which request is
                 * likelier to have landed on a guild screen.</p>
                 *
                 * <p><b>Never hardcode a copy of one.</b> It is on the wire so that the day a rung is
                 * added, a picker gains it without a release.</p>
                 */
                ladder(name: string, guildId?: string | null): EntitlementRungDto[] | undefined {
                    const guild = guildId
                        ? snapshotOf({kind: 'guild', id: guildId})?.ladders?.[name]
                        : undefined;
                    return guild ?? snapshotOf(MY_ENTITLEMENTS)?.ladders?.[name];
                },

                ensureLoaded(subject: EntitlementSubjectRef): void {
                    const key = keyFor(subject);
                    const entry = store.byCacheKey()[key];
                    if (fresh(entry) || entry?.loading) return;

                    const requestId = (entry?.requestId ?? 0) + 1;
                    write(key, {
                        snapshot: entry?.snapshot ?? null,
                        fetchedAt: entry?.fetchedAt ?? 0,
                        loading: true,
                        requestId,
                    });

                    const request =
                        subject.kind === 'guild'
                            ? entitlements.getForGuild(subject.id)
                            : entitlements.getMine();

                    request.subscribe({
                        next: snapshot => {
                            const current = store.byCacheKey()[key];
                            if (current?.requestId !== requestId) return;
                            // Two checks the guide is explicit about, and both are about a response that
                            // arrived after the world moved. The subject echo catches a switch of account
                            // or instance mid-flight; the version catches an older set overtaking a newer
                            // one. `version` is zero on every instance until Billing owns a counter, and
                            // comparing it is still correct - it starts working the day it moves.
                            const discard =
                                !answersFor(snapshot, subject) ||
                                (current.snapshot !== null && snapshot.version < current.snapshot.version);

                            // A discarded response still clears the loading flag. Returning early here
                            // leaves the entry marked in flight for a request that already came back,
                            // and every later read is blocked by it.
                            write(
                                key,
                                discard
                                    ? {...current, loading: false}
                                    : {snapshot, fetchedAt: Date.now(), loading: false, requestId},
                            );
                        },
                        error: () => {
                            const current = store.byCacheKey()[key];
                            if (current?.requestId !== requestId) return;
                            write(key, {...current, loading: false});
                        },
                    });
                },

                invalidate(subject: EntitlementSubjectRef): boolean {
                    const key = keyFor(subject);
                    const entry = store.byCacheKey()[key];
                    const features = store.featuresByCacheKey()[key];

                    // The module resolution goes with the ceilings. A plan change moves both, and a
                    // client that refetched only the numbers would keep telling a guild that just
                    // bought Forums that Forums is not in its plan.
                    if (features) {
                        writeFeatures(key, {
                            resolution: null,
                            loading: false,
                            requestId: features.requestId + 1,
                        });
                    }

                    if (!entry) return false;
                    // Supersedes any in-flight fetch and clears loading, so the follow-up ensureLoaded
                    // issues a fresh request rather than being blocked by a now-stale flag.
                    write(key, {...entry, fetchedAt: 0, loading: false, requestId: entry.requestId + 1});
                    return true;
                },

                /**
                 * One guild's module resolution, or null when none has been read.
                 *
                 * <p>Null is "not loaded" and never "no modules" - the resolution is absent from the
                 * guild list, so most guilds most of the time have none held.</p>
                 */
                features: featuresOf,

                /**
                 * Why a module is not usable here: `on`, `off`, `withheld`, or `unknown` while nothing
                 * is held.
                 *
                 * <p>Callers keep their existing `features` check for `on`/`off` and use this for the
                 * one answer that string cannot carry. `unknown` must render as whatever the caller did
                 * before this existed: a resolution that has not arrived is not evidence of anything.
                 * </p>
                 */
                moduleStanding(guildId: string, feature: string): 'on' | 'off' | 'withheld' | 'unknown' {
                    return moduleStandingOf(featuresOf(guildId), feature);
                },

                /** Files a resolution that rode a single-guild read, so a module screen needs no call. */
                putFeatures(guildId: string, resolution: GuildFeatureResolutionDto | undefined): void {
                    if (!resolution) return;
                    const key = keyFor({kind: 'guild', id: guildId});
                    const entry = store.featuresByCacheKey()[key];
                    writeFeatures(key, {resolution, loading: false, requestId: (entry?.requestId ?? 0) + 1});
                },

                ensureFeaturesLoaded(guildId: string): void {
                    const key = keyFor({kind: 'guild', id: guildId});
                    const entry = store.featuresByCacheKey()[key];
                    if (entry?.resolution || entry?.loading) return;

                    const requestId = (entry?.requestId ?? 0) + 1;
                    writeFeatures(key, {resolution: null, loading: true, requestId});

                    guilds.getGuildFeatures(guildId).subscribe({
                        next: resolution => {
                            const current = store.featuresByCacheKey()[key];
                            if (current?.requestId !== requestId) return;
                            writeFeatures(key, {resolution, loading: false, requestId});
                        },
                        // A failed read proves nothing about the plan, so it leaves `unknown` in place
                        // rather than an empty resolution - which would read as "every module is off".
                        error: () => {
                            const current = store.featuresByCacheKey()[key];
                            if (current?.requestId !== requestId) return;
                            writeFeatures(key, {...current, loading: false});
                        },
                    });
                },

                /**
                 * The largest single upload allowed here, or null when nothing caps it.
                 *
                 * <p>Two keys, and which applies depends on where the file is going:
                 * `storage.upload_max_bytes` inside a guild, `user.upload_max_bytes` outside one. The
                 * guild key is paired, so what the caller actually gets is the lower of the two sides -
                 * computed by the server at the moment of the upload. Reading the lower of what is held
                 * is a courtesy that stops the obvious rejections early; the `403` still has to be
                 * handled, because the ceiling can move between this read and the transfer.</p>
                 */
                uploadCeilingBytes(guildId: string | null): number | null {
                    const own = numericCeiling(valueOf(MY_ENTITLEMENTS, ENTITLEMENT_KEYS.userUploadMaxBytes));
                    if (!guildId) return own;

                    const guild = numericCeiling(
                        valueOf({kind: 'guild', id: guildId}, ENTITLEMENT_KEYS.storageUploadMaxBytes),
                    );
                    if (guild === null) return own;
                    return own === null ? guild : Math.min(own, guild);
                },
            };
        },
    ),

    withComputed((store, apiConfig = inject(ApiConfigService), profile = inject(ProfileService)) => {
        const mine = computed(() => {
            const key = cacheKey(apiConfig.baseUrl(), profile.ownProfile()?.userId ?? 'anon', 'user', 'me');
            return store.byCacheKey()[key]?.snapshot ?? null;
        });

        return {
            mine,

            /** The caller's own plan, or null when the server named none. Never invent one. */
            myPlan: computed(() => mine()?.plan ?? null),

            /**
             * Whether to draw an upgrade affordance at all.
             *
             * <p>False on a self-hosted instance, which has no billing service deployed, and also
             * false on a hosted one whose billing is not configured yet - a supported state during
             * rollout. <b>Omit the surface rather than disabling it</b>: the absence needs no
             * explanation, and a disabled buy button on an instance that sells nothing is a paywall
             * for a product nobody is charging for. Limits still apply either way; they simply
             * arrive with `remedy: "none"`.</p>
             *
             * <p>False while nothing is loaded, which is deliberate: the safe default for "should
             * this instance show billing" is no.</p>
             */
            upgradesAvailable: computed(() => mine()?.upgradesAvailable === true),

            licenseMode: computed(() => mine()?.licenseMode ?? null),

            /**
             * The Stripe publishable key to initialise checkout with: the instance's own when it
             * sends one, the compiled-in development default otherwise.
             *
             * <p>Blank counts as absent. The server omits the field rather than sending an empty
             * string, but `??` alone would hand an empty one straight to Stripe on the day some
             * instance's configuration disagrees, and a checkout that fails to initialise is a
             * worse answer than the fallback.</p>
             */
            stripePublishableKey: computed(() => {
                const fromInstance = mine()?.stripePublishableKey?.trim();
                return fromInstance ? fromInstance : environment.stripePublishableKey;
            }),
        };
    }),

    withHooks({
        onInit(store) {
            const realtime = inject(RealtimeConnectionService);

            // An envelope, not the values: a guild plan change fans out to every online member, and
            // delivery is unordered, so a pushed value can arrive stale and overwrite a newer one.
            // Invalidating and refetching what is actually held is monotonic; taking the payload's
            // word for it is not.
            realtime.on('entitlements.Changed', (e: EntitlementsChangedDto) => {
                const subject: EntitlementSubjectRef =
                    e.subjectKind === 'guild' ? {kind: 'guild', id: e.subjectId} : MY_ENTITLEMENTS;
                // Refetch what is actually held. A change to a guild fans out to every online
                // member, and most of them have nothing of that guild open; pulling a set for each
                // of them turns one purchase into a request from everybody who was logged in.
                const heldFeatures = subject.kind === 'guild' && store.features(subject.id) !== null;
                if (store.invalidate(subject)) store.ensureLoaded(subject);
                // Held separately: a member with a module screen open has the resolution and often
                // not the ceilings, and that is the screen the change is most visible on.
                if (heldFeatures && subject.kind === 'guild') store.ensureFeaturesLoaded(subject.id);
            });
        },
    }),
);

/**
 * Whether a response is about the subject that was asked for.
 *
 * <p>`/me` answers with the caller's own id rather than the literal `me`, so the user case checks
 * only the kind - which is all it can check, and all it needs to: the account is already in the
 * cache key, so a response that arrived after an account switch is filed under a key nothing reads.
 * </p>
 */
function answersFor(snapshot: EntitlementSnapshotDto, subject: EntitlementSubjectRef): boolean {
    if (snapshot.subject?.kind !== subject.kind) return false;
    return subject.kind !== 'guild' || snapshot.subject.id === subject.id;
}
