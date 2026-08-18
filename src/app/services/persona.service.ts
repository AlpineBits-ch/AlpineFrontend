import {DestroyRef, inject, Injectable, Injector, signal} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {Observable, tap} from 'rxjs';
import {PersonaApi} from './persona-api.service';
import {GuildWebsocketService} from './guild-websocket.service';
import {AutoproxyMode, ChannelAutoproxyDto, GuildPersonaDto, PersonaDto} from '../dtos/response/persona.dto';
import {
    CreatePersonaDto,
    RequestPersonaChangesDto,
    UpdatePersonaDto,
    UpsertPersonaProfileDto,
} from '../dtos/request/persona.dto';
import {UpdateWikiPageDto} from '../dtos/request/wiki.dto';
import {WikiCategoryDto, WikiPageDto} from '../dtos/response/wiki.dto';
import {
    canSpeakAs,
    identityFromHint,
    PersonaDisplayHint,
    PersonaIdentity,
    personaIdentity,
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
    private readonly autoproxyByChannel = signal<Record<string, ChannelAutoproxyDto>>({});
    private readonly selectionByChannel = signal<Record<string, string | null>>({});

    private ownRequested = false;
    private readonly requestedGuilds = new Set<string>();
    private readonly requestedChannels = new Set<string>();

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
        const ws = this.injector.get(GuildWebsocketService);

        ws.personaProfileChangedObservable.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(event => {
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

        ws.personaUpdatedObservable.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(event => {
            this.patchPersona(event.personaId, {name: event.name, avatarUrl: event.avatarUrl ?? null});
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

    entry(guildId: string | null | undefined, personaId: string | null | undefined): GuildPersonaDto | null {
        if (!personaId) return null;
        return this.cast(guildId).find(e => e.persona.id === personaId) ?? null;
    }

    /**
     * How a character is drawn, wherever only an id is to hand. The cast wins because it carries
     * this guild's overrides; a hint stands in for anybody the caller cannot speak as.
     */
    identity(
        guildId: string | null | undefined,
        personaId: string | null | undefined,
        hint?: PersonaDisplayHint | null,
    ): PersonaIdentity | null {
        if (!personaId) return null;
        const entry = this.entry(guildId, personaId);
        return entry ? personaIdentity(entry) : identityFromHint(personaId, hint);
    }

    autoproxy(channelId: string | null | undefined): ChannelAutoproxyDto | null {
        return channelId ? (this.autoproxyByChannel()[channelId] ?? null) : null;
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

    ensureAutoproxy(guildId: string | null | undefined, channelId: string | null | undefined): void {
        if (!guildId || !channelId || this.requestedChannels.has(channelId)) return;
        this.requestedChannels.add(channelId);
        this.api.getAutoproxy(guildId, channelId).subscribe({
            next: state => this.autoproxyByChannel.update(map => ({...map, [channelId]: state})),
            error: () => undefined,
        });
    }

    listPending(guildId: string): Observable<GuildPersonaDto[]> {
        return this.api.listPending(guildId);
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
        return this.api.removeProfile(guildId, personaId).pipe(
            tap(() =>
                this.casts.update(map => ({
                    ...map,
                    [guildId]: (map[guildId] ?? []).filter(e => e.persona.id !== personaId),
                })),
            ),
        );
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

    pullPage(guildId: string, personaId: string, strategy: 'preview' | 'apply') {
        return this.api.pullPage(guildId, personaId, {strategy}).pipe(
            tap(result => {
                if (result.applied) {
                    this.patchProfile(guildId, personaId, {upstreamState: result.upstreamState});
                }
            }),
        );
    }

    // ── Cache maintenance ───────────────────────────────────────────────────

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
