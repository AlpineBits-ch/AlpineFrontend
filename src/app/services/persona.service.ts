import {DestroyRef, inject, Injectable, Injector, signal} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {merge, Observable, tap} from 'rxjs';
import {PersonaApi} from './persona-api.service';
import {WsPersonaChanged} from '../dtos/response/persona-events.dto';
import {
    AutoproxyMode,
    ChannelAutoproxyDto,
    GuildPersonaDto,
    PersonaCastMemberDto,
    PersonaDto,
    PersonaPagePullStrategy,
    PersonaScope,
} from '../dtos/response/persona.dto';
import {
    CreatePersonaDto,
    RequestPersonaChangesDto,
    UpdatePersonaDto,
    UpsertPersonaProfileDto,
} from '../dtos/request/persona.dto';
import {UpdateWikiPageDto} from '../dtos/request/wiki.dto';
import {WikiCategoryDto, WikiPageDto} from '../dtos/response/wiki.dto';
import {RealtimeConnectionService} from './realtime-connection.service';
import {
    canSpeakAs,
    identityFromCastMember,
    identityFromHint,
    PersonaDisplayHint,
    PersonaIdentity,
    personaIdentity,
    sortCastMembers,
    sortPersonas,
} from '../features/guild/personas/persona-identity';
import {
    hasProxyTags,
    ProxyResolution,
    proxyTagsOf,
    resolveProxy,
} from '../features/guild/personas/persona-proxy';

/**
 * Personas as the UI reads them: the account's own list, one cast per guild, and the two pieces of
 * per-channel state that decide who speaks. The switcher's choice lives here and nowhere on disk -
 * autoproxy is the server-side way to make a choice stick, so a second local memory of it would be
 * a second source of truth.
 */
@Injectable({providedIn: 'root'})
export class PersonaService {
    /**
     * Both dependencies are resolved on the first read rather than injected. `PersonaApi` is chosen
     * by `app.config.ts` and the realtime hub drags OAuth in behind it, and this service is reached
     * from the composer and every message row, neither of which touches a persona in most channels.
     */
    private readonly injector = inject(Injector);
    private readonly destroyRef = inject(DestroyRef);
    private wired = false;

    readonly ownPersonas = signal<PersonaDto[]>([]);
    readonly ownLoading = signal(false);

    private readonly casts = signal<Record<string, GuildPersonaDto[]>>({});
    private readonly loadingGuilds = signal<Record<string, boolean>>({});
    private readonly guildCasts = signal<Record<string, PersonaCastMemberDto[]>>({});
    private readonly loadingGuildCasts = signal<Record<string, boolean>>({});
    private readonly autoproxyByChannel = signal<Record<string, ChannelAutoproxyDto>>({});
    private readonly selectionByChannel = signal<Record<string, string | null>>({});
    private readonly pendingByGuild = signal<Record<string, GuildPersonaDto[]>>({});
    private readonly loadingPending = signal<Record<string, boolean>>({});
    /** Bumped when a pull rewrote a character page, so whoever has it open reads it again. */
    private readonly pageVersions = signal<Record<string, number>>({});

    private ownRequested = false;
    private readonly requestedGuilds = new Set<string>();
    private readonly requestedGuildCasts = new Set<string>();
    private readonly requestedChannels = new Set<string>();
    private readonly requestedPending = new Set<string>();

    private get api(): PersonaApi {
        return this.injector.get(PersonaApi);
    }

    /**
     * Subscribes to the guild hub the first time anything is actually read. Events before that have
     * nothing to patch, since no cast has been loaded yet.
     */
    private wire(): void {
        if (this.wired) return;
        this.wired = true;
        const realtime = this.injector.get(RealtimeConnectionService);

        realtime
            .stream('guild.PersonaProfileChanged')
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(event => {
                this.patchProfile(event.guildId, event.personaId, {
                    approvalState: event.approvalState,
                });

                // The event's `canSpeak` is the profile's own state, broadcast to the whole guild,
                // so it can only be trusted to close: a true says nothing about this reader's grants.
                if (!event.canSpeak) {
                    this.patchProfile(event.guildId, event.personaId, {canSpeak: false});
                } else if (this.entry(event.guildId, event.personaId)) {
                    this.ensureCast(event.guildId, true);
                }
            });

        realtime
            .stream('guild.PersonaCreated')
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(event => {
                if (this.knows(event.personaId)) {
                    this.patchPersona(event.personaId, personaPatch(event));
                    return;
                }
                // A guild-owned character reaches the cast through `guild.PersonaAdopted`, which follows.
                if (event.scope === PersonaScope.User) this.ensureOwn(true);
            });

        realtime
            .stream('guild.PersonaUpdated')
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(event => {
                this.patchPersona(event.personaId, personaPatch(event));
                this.refreshGuildCast(event.guildId);
            });

        realtime
            .stream('guild.PersonaDeleted')
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(event => {
                if (event.retired) this.patchPersona(event.personaId, {isRetired: true});
                else this.forget(event.personaId);
                this.refreshGuildCast(event.guildId);
            });

        realtime
            .stream('guild.PersonaAdopted')
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(event => {
                // No entry can be built from this: it carries the display data, not the character.
                if (this.entry(event.guildId, event.personaId)) {
                    this.patchProfile(event.guildId, event.personaId, {
                        approvalState: event.approvalState,
                        tag: event.tag ?? null,
                        wikiPageId: event.wikiPageId ?? null,
                    });
                } else if (this.requestedGuilds.has(event.guildId)) {
                    this.ensureCast(event.guildId, true);
                }
                this.refreshGuildCast(event.guildId);
            });

        realtime
            .stream('guild.PersonaUnadopted')
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(event => {
                this.dropEntry(event.guildId, event.personaId);
                this.refreshGuildCast(event.guildId);
            });

        realtime
            .stream('guild.PersonaReviewRequested')
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(event => {
                // Players get this event too, and the queue route is theirs to be refused.
                if (this.requestedPending.has(event.guildId)) this.ensurePending(event.guildId, true);
            });

        realtime
            .stream('guild.PersonaReviewCompleted')
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(event => {
                this.patchProfile(event.guildId, event.personaId, {
                    approvalState: event.approvalState,
                    changesRequestedReason: event.approved ? null : (event.reason ?? null),
                    approvedByUserId: event.approved ? event.reviewedByUserId : null,
                    approvedAt: event.approved ? (event.reviewedAt ?? null) : null,
                });
                // `canSpeak` is left to the guild-wide `PersonaProfileChanged` that goes out with this.
                this.pendingByGuild.update(map => ({
                    ...map,
                    [event.guildId]: (map[event.guildId] ?? []).filter(e => e.persona.id !== event.personaId),
                }));
            });

        merge(realtime.stream('guild.PersonaGrantCreated'), realtime.stream('guild.PersonaGrantDeleted'))
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(event => {
                // A grant decides `canSpeak`, which is resolved per reader. Only a re-read answers it.
                if (this.requestedGuilds.has(event.guildId)) this.ensureCast(event.guildId, true);
            });

        realtime
            .stream('guild.PersonaPageCreated')
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(event =>
                this.patchProfile(event.guildId, event.personaId, {wikiPageId: event.pageId}),
            );

        realtime
            .stream('guild.PersonaPagePulled')
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(event => {
                this.patchProfile(event.guildId, event.personaId, {
                    upstreamState: event.upstreamState,
                    upstreamRevisionNumber: event.upstreamRevisionNumber ?? null,
                });
                this.pageVersions.update(map => ({...map, [event.pageId]: (map[event.pageId] ?? 0) + 1}));
            });

        realtime
            .stream('guild.AutoproxyChanged')
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(event => {
                this.autoproxyByChannel.update(map => ({
                    ...map,
                    [event.channelId]: {
                        channelId: event.channelId,
                        mode: event.mode,
                        personaId: event.personaId ?? null,
                    },
                }));
            });
    }

    // ── Reads ───────────────────────────────────────────────────────────────

    /** Everything the caller may speak as in this guild, retired characters included. */
    cast(guildId: string | null | undefined): GuildPersonaDto[] {
        return guildId ? (this.casts()[guildId] ?? []) : [];
    }

    /** Only what can be picked right now: not retired, and not blocked by an approval gate. */
    speakable(guildId: string | null | undefined): GuildPersonaDto[] {
        return sortPersonas(this.cast(guildId).filter(canSpeakAs));
    }

    isLoading(guildId: string | null | undefined): boolean {
        return !!guildId && !!this.loadingGuilds()[guildId];
    }

    /**
     * Every character the guild has adopted, whoever plays them. This is the read behind a turn
     * order, a cast picker or a `<@pers_...>` token; `cast()` cannot answer for somebody else.
     */
    guildCast(guildId: string | null | undefined): PersonaCastMemberDto[] {
        return guildId ? (this.guildCasts()[guildId] ?? []) : [];
    }

    guildCastMember(
        guildId: string | null | undefined,
        personaId: string | null | undefined,
    ): PersonaCastMemberDto | null {
        if (!personaId || !guildId) return null;
        return (this.guildCasts()[guildId] ?? []).find(m => m.personaId === personaId) ?? null;
    }

    isGuildCastLoading(guildId: string | null | undefined): boolean {
        return !!guildId && !!this.loadingGuildCasts()[guildId];
    }

    entry(guildId: string | null | undefined, personaId: string | null | undefined): GuildPersonaDto | null {
        if (!personaId) return null;
        return this.cast(guildId).find(e => e.persona.id === personaId) ?? null;
    }

    /**
     * How a character is drawn, wherever only an id is to hand. The speakable entry wins because it
     * carries this guild's overrides, then the guild cast for anybody else's character, then a hint
     * for a guild whose cast has never been read.
     */
    identity(
        guildId: string | null | undefined,
        personaId: string | null | undefined,
        hint?: PersonaDisplayHint | null,
    ): PersonaIdentity | null {
        if (!personaId) return null;
        const entry = this.entry(guildId, personaId);
        if (entry) return personaIdentity(entry);
        const member = this.guildCastMember(guildId, personaId);
        return member ? identityFromCastMember(member) : identityFromHint(personaId, hint);
    }

    autoproxy(channelId: string | null | undefined): ChannelAutoproxyDto | null {
        return channelId ? (this.autoproxyByChannel()[channelId] ?? null) : null;
    }

    /**
     * The review queue. Read from its own route, not from the cast: the cast is what the caller may
     * speak as, and a reviewer is precisely somebody looking at characters that are not theirs.
     */
    pending(guildId: string | null | undefined): GuildPersonaDto[] {
        return guildId ? (this.pendingByGuild()[guildId] ?? []) : [];
    }

    isPendingLoading(guildId: string | null | undefined): boolean {
        return !!guildId && !!this.loadingPending()[guildId];
    }

    /** How many times this character page has been rewritten by a pull this session. */
    pageVersion(pageId: string | null | undefined): number {
        return pageId ? (this.pageVersions()[pageId] ?? 0) : 0;
    }

    /** The switcher's choice for this channel, for this session. */
    selected(channelId: string | null | undefined): string | null {
        return channelId ? (this.selectionByChannel()[channelId] ?? null) : null;
    }

    /**
     * Who this draft would be sent as. The composer sends by it and the switcher displays it, so
     * the preview cannot drift from what actually goes out.
     */
    resolveFor(
        guildId: string | null | undefined,
        channelId: string | null | undefined,
        content: string,
    ): ProxyResolution {
        return resolveProxy(content, {
            explicitPersonaId: this.selected(channelId),
            candidates: this.speakable(guildId).map(proxyTagsOf).filter(hasProxyTags),
            autoproxy: this.autoproxy(channelId),
        });
    }

    // ── Loading ─────────────────────────────────────────────────────────────

    ensureOwn(force = false): void {
        this.wire();
        if (this.ownRequested && !force) return;
        this.ownRequested = true;
        this.ownLoading.set(true);
        this.api.listOwn().subscribe({
            next: rows => {
                this.ownPersonas.set(rows);
                this.ownLoading.set(false);
            },
            error: () => this.ownLoading.set(false),
        });
    }

    ensureCast(guildId: string | null | undefined, force = false): void {
        if (!guildId) return;
        this.wire();
        if (this.requestedGuilds.has(guildId) && !force) return;
        this.requestedGuilds.add(guildId);
        this.loadingGuilds.update(map => ({...map, [guildId]: true}));
        this.api.listGuild(guildId).subscribe({
            next: rows => {
                this.casts.update(map => ({...map, [guildId]: rows}));
                this.loadingGuilds.update(map => ({...map, [guildId]: false}));
            },
            // Keeps whatever cast was already loaded: a failed refresh must not empty the switcher.
            error: () => this.loadingGuilds.update(map => ({...map, [guildId]: false})),
        });
    }

    /** Membership is enough for this one, unlike `ensureCast`. */
    ensureGuildCast(guildId: string | null | undefined, force = false): void {
        if (!guildId) return;
        this.wire();
        if (this.requestedGuildCasts.has(guildId) && !force) return;
        this.requestedGuildCasts.add(guildId);
        this.loadingGuildCasts.update(map => ({...map, [guildId]: true}));
        this.api.getGuildCast(guildId).subscribe({
            // Sorted once here, so a read hands back the same array every time.
            next: rows => {
                this.guildCasts.update(map => ({...map, [guildId]: sortCastMembers(rows)}));
                this.loadingGuildCasts.update(map => ({...map, [guildId]: false}));
            },
            // Keeps whatever was loaded: a failed refresh must not blank every name on screen.
            error: () => this.loadingGuildCasts.update(map => ({...map, [guildId]: false})),
        });
    }

    ensureAutoproxy(guildId: string | null | undefined, channelId: string | null | undefined): void {
        if (!guildId || !channelId || this.requestedChannels.has(channelId)) return;
        this.wire();
        this.requestedChannels.add(channelId);
        this.api.getAutoproxy(guildId, channelId).subscribe({
            next: state => this.autoproxyByChannel.update(map => ({...map, [channelId]: state})),
            error: () => undefined,
        });
    }

    /** Only for a caller who holds `ApprovePersonas`; the route refuses anybody else. */
    ensurePending(guildId: string | null | undefined, force = false): void {
        if (!guildId) return;
        this.wire();
        if (this.requestedPending.has(guildId) && !force) return;
        this.requestedPending.add(guildId);
        this.loadingPending.update(map => ({...map, [guildId]: true}));
        this.api.listPending(guildId).subscribe({
            next: rows => {
                this.pendingByGuild.update(map => ({...map, [guildId]: rows}));
                this.loadingPending.update(map => ({...map, [guildId]: false}));
            },
            error: () => this.loadingPending.update(map => ({...map, [guildId]: false})),
        });
    }

    /** Drops the queue when the permission behind it is gone, so no event refetches it again. */
    forgetPending(guildId: string | null | undefined): void {
        if (!guildId) return;
        this.requestedPending.delete(guildId);
        this.pendingByGuild.update(map => ({...map, [guildId]: []}));
        this.loadingPending.update(map => ({...map, [guildId]: false}));
    }

    // ── Speaking ────────────────────────────────────────────────────────────

    select(channelId: string, personaId: string | null): void {
        this.selectionByChannel.update(map => ({...map, [channelId]: personaId}));
    }

    setAutoproxy(
        guildId: string,
        channelId: string,
        mode: AutoproxyMode,
        personaId: string | null,
    ): Observable<ChannelAutoproxyDto> {
        return this.api
            .setAutoproxy(guildId, channelId, {mode, personaId})
            .pipe(tap(state => this.autoproxyByChannel.update(map => ({...map, [channelId]: state}))));
    }

    // ── Writes ──────────────────────────────────────────────────────────────

    createOwn(dto: CreatePersonaDto): Observable<PersonaDto> {
        return this.api
            .createOwn(dto)
            .pipe(tap(created => this.ownPersonas.update(rows => [...rows, created])));
    }

    updateOwn(personaId: string, dto: UpdatePersonaDto): Observable<PersonaDto> {
        return this.api.updateOwn(personaId, dto).pipe(tap(updated => this.absorb(updated)));
    }

    deleteOwn(personaId: string): Observable<{personaId: string; retired: boolean}> {
        return this.api.deleteOwn(personaId).pipe(
            tap(result => {
                if (result.retired) this.patchPersona(personaId, {isRetired: true});
                else this.forget(personaId);
            }),
        );
    }

    createGuildPersona(guildId: string, dto: CreatePersonaDto): Observable<GuildPersonaDto> {
        return this.api
            .createGuildPersona(guildId, dto)
            .pipe(
                tap(entry =>
                    this.casts.update(map => ({...map, [guildId]: [...(map[guildId] ?? []), entry]})),
                ),
            );
    }

    updateGuildPersona(guildId: string, personaId: string, dto: UpdatePersonaDto): Observable<PersonaDto> {
        return this.api.updateGuildPersona(guildId, personaId, dto).pipe(tap(p => this.absorb(p)));
    }

    deleteGuildPersona(guildId: string, personaId: string): Observable<void> {
        return this.api.deleteGuildPersona(guildId, personaId).pipe(tap(() => this.forget(personaId)));
    }

    /** Adopts into the guild when there is no profile yet, and sets the overrides either way. */
    saveProfile(
        guildId: string,
        personaId: string,
        dto: UpsertPersonaProfileDto,
    ): Observable<GuildPersonaDto> {
        return this.api
            .putProfile(guildId, personaId, dto)
            .pipe(tap(entry => this.upsertEntry(guildId, entry)));
    }

    removeProfile(guildId: string, personaId: string): Observable<void> {
        return this.api.removeProfile(guildId, personaId).pipe(tap(() => this.dropEntry(guildId, personaId)));
    }

    uploadAvatar(personaId: string, file: File): Observable<PersonaDto> {
        return this.api.uploadAvatar(personaId, file).pipe(tap(updated => this.absorb(updated)));
    }

    removeAvatar(personaId: string): Observable<void> {
        return this.api
            .removeAvatar(personaId)
            .pipe(tap(() => this.patchPersona(personaId, {avatarUrl: null})));
    }

    uploadProfileAvatar(guildId: string, personaId: string, file: File): Observable<GuildPersonaDto> {
        return this.api
            .uploadProfileAvatar(guildId, personaId, file)
            .pipe(tap(entry => this.upsertEntry(guildId, entry)));
    }

    removeProfileAvatar(guildId: string, personaId: string): Observable<GuildPersonaDto> {
        return this.api
            .removeProfileAvatar(guildId, personaId)
            .pipe(tap(entry => this.upsertEntry(guildId, entry)));
    }

    submit(guildId: string, personaId: string): Observable<GuildPersonaDto> {
        return this.api
            .submitProfile(guildId, personaId)
            .pipe(tap(entry => this.upsertEntry(guildId, entry)));
    }

    approve(guildId: string, personaId: string): Observable<GuildPersonaDto> {
        return this.api
            .approveProfile(guildId, personaId)
            .pipe(tap(entry => this.upsertEntry(guildId, entry)));
    }

    requestChanges(
        guildId: string,
        personaId: string,
        dto: RequestPersonaChangesDto,
    ): Observable<GuildPersonaDto> {
        return this.api
            .requestChanges(guildId, personaId, dto)
            .pipe(tap(entry => this.upsertEntry(guildId, entry)));
    }

    createPage(guildId: string, personaId: string): Observable<WikiPageDto> {
        return this.api
            .createPage(guildId, personaId)
            .pipe(tap(page => this.patchProfile(guildId, personaId, {wikiPageId: page.id})));
    }

    getPage(guildId: string, pageId: string): Observable<WikiPageDto> {
        return this.api.getPage(guildId, pageId);
    }

    savePage(guildId: string, pageId: string, dto: UpdateWikiPageDto): Observable<WikiPageDto> {
        return this.api.savePage(guildId, pageId, dto);
    }

    listCategories(guildId: string): Observable<WikiCategoryDto[]> {
        return this.api.listCategories(guildId);
    }

    pullPage(guildId: string, personaId: string, strategy: PersonaPagePullStrategy) {
        return this.api.pullPage(guildId, personaId, {strategy}).pipe(
            tap(result => {
                if (result.applied) {
                    this.patchProfile(guildId, personaId, {upstreamState: result.upstreamState});
                }
            }),
        );
    }

    // ── Cache maintenance ───────────────────────────────────────────────────

    /** Re-reads the guild-wide cast, but only where something is already showing it. */
    private refreshGuildCast(guildId: string | null | undefined): void {
        if (guildId && this.requestedGuildCasts.has(guildId)) this.ensureGuildCast(guildId, true);
    }

    private absorb(persona: PersonaDto): void {
        this.patchPersona(persona.id, persona);
    }

    private patchPersona(personaId: string, patch: Partial<PersonaDto>): void {
        this.ownPersonas.update(rows => rows.map(p => (p.id === personaId ? {...p, ...patch} : p)));
        this.casts.update(map =>
            Object.fromEntries(
                Object.entries(map).map(([guildId, entries]) => [
                    guildId,
                    entries.map(e =>
                        e.persona.id === personaId ? {...e, persona: {...e.persona, ...patch}} : e,
                    ),
                ]),
            ),
        );
    }

    private patchProfile(guildId: string, personaId: string, patch: Partial<GuildPersonaDto>): void {
        this.casts.update(map => ({
            ...map,
            [guildId]: (map[guildId] ?? []).map(e => (e.persona.id === personaId ? {...e, ...patch} : e)),
        }));
    }

    private dropEntry(guildId: string, personaId: string): void {
        this.casts.update(map => ({
            ...map,
            [guildId]: (map[guildId] ?? []).filter(e => e.persona.id !== personaId),
        }));
    }

    /** Whether this character is held anywhere, either as the account's own or in some guild's cast. */
    private knows(personaId: string): boolean {
        if (this.ownPersonas().some(p => p.id === personaId)) return true;
        return Object.values(this.casts()).some(entries => entries.some(e => e.persona.id === personaId));
    }

    private upsertEntry(guildId: string, entry: GuildPersonaDto): void {
        this.casts.update(map => {
            const rows = map[guildId] ?? [];
            const at = rows.findIndex(e => e.persona.id === entry.persona.id);
            const next = at < 0 ? [...rows, entry] : rows.map((e, i) => (i === at ? entry : e));
            return {...map, [guildId]: next};
        });
    }

    private forget(personaId: string): void {
        this.ownPersonas.update(rows => rows.filter(p => p.id !== personaId));
        this.casts.update(map =>
            Object.fromEntries(
                Object.entries(map).map(([guildId, entries]) => [
                    guildId,
                    entries.filter(e => e.persona.id !== personaId),
                ]),
            ),
        );
    }
}

/** The character's own fields as `guild.PersonaCreated` and `guild.PersonaUpdated` carry them. */
function personaPatch(event: WsPersonaChanged): Partial<PersonaDto> {
    return {
        scope: event.scope,
        name: event.name,
        avatarUrl: event.avatarUrl ?? null,
        pronouns: event.pronouns ?? null,
        color: event.color ?? null,
        shortBio: event.shortBio ?? null,
        isRetired: event.isRetired,
    };
}
