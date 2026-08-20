import {DestroyRef, inject, Injectable, Injector, signal} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {Observable, tap} from 'rxjs';
import {RoleplayApi} from './roleplay-api.service';
import {PersonaService} from './persona.service';
import {GuildWebsocketService} from './guild-websocket.service';
import {GuildService} from './guild.service';
import {NavigationService} from '../features/main-page/navigation.service';
import {
    SceneCreatedDto,
    SceneDto,
    SceneListItemDto,
    SceneStatus,
    SceneTurnNudgeDto,
} from '../dtos/response/scene.dto';
import {
    AddSceneParticipantDto,
    AdvanceTurnDto,
    CreateSceneDto,
    SkipTurnDto,
    UpdateSceneDto,
} from '../dtos/request/scene.dto';
import {compareScenes, isWaitingOnMe, queueFromCurrent} from '../features/guild/scenes/scene-status';

/** How often the clocks redraw. A play-by-post deadline is measured in days; this is plenty. */
const TICK_MS = 20_000;

/** A nudge that has arrived and not yet been answered. */
export interface SceneNudge {
    channelId: string;
    personaId: string;
    sceneName: string | null;
    receivedAt: number;
    nudgeCount: number;
    toGameMaster: boolean;
}

/**
 * Scenes as the UI reads them: one list per guild, one clock for all of them, and the answer to
 * "is anything waiting on me". Loaded lazily, like the persona cast, because most channels are not
 * scenes and most guilds have none.
 */
@Injectable({providedIn: 'root'})
export class SceneService {
    private readonly injector = inject(Injector);
    private readonly destroyRef = inject(DestroyRef);
    private readonly personas = inject(PersonaService);
    private wired = false;

    /** Ticks so every clock in the app redraws together rather than each holding its own timer. */
    readonly now = signal(Date.now());

    /** The board: one page of list rows per guild. Not scenes; the list route answers a lighter shape. */
    private readonly byGuild = signal<Record<string, SceneListItemDto[]>>({});
    /** Whole scenes, keyed by channel, as the per-scene route and the writes return them. */
    private readonly sceneByChannel = signal<Record<string, SceneDto>>({});
    private readonly truncatedGuilds = signal<Record<string, boolean>>({});
    private readonly loadingGuilds = signal<Record<string, boolean>>({});
    private readonly nudgesByChannel = signal<Record<string, SceneNudge>>({});

    private readonly requestedGuilds = new Set<string>();
    /** Guilds with a channel-list read in flight, so a board of new scenes costs one of them. */
    private readonly learningGuilds = new Set<string>();

    constructor() {
        const timer = setInterval(() => this.now.set(Date.now()), TICK_MS);
        this.destroyRef.onDestroy(() => clearInterval(timer));
    }

    private get api(): RoleplayApi {
        return this.injector.get(RoleplayApi);
    }

    private wire(): void {
        if (this.wired) return;
        this.wired = true;
        const ws = this.injector.get(GuildWebsocketService);

        ws.sceneCreatedObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(event => this.noteCreated(event));

        ws.sceneConcludedObservable.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(event => {
            this.patch(event.guildId, event.channelId, {
                status: event.status,
                conclusionNote: event.conclusionNote,
                turnNumber: event.turnNumber,
                postCount: event.postCount,
                concludedAt: event.concludedAt,
            });
            this.clearNudge(event.channelId);
        });

        ws.sceneTurnChangedObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(event => this.patch(event.guildId, event.channelId, event));

        ws.sceneUpdatedObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(event => this.patch(event.guildId, event.channelId, event));

        ws.sceneTurnNudgeObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(event => this.noteNudge(event));
    }

    // ── Reads ───────────────────────────────────────────────────────────────

    /** The board's rows. A row is not a scene: no cast, no rotation. */
    scenes(guildId: string | null | undefined): SceneListItemDto[] {
        return guildId ? (this.byGuild()[guildId] ?? []) : [];
    }

    /** True when the guild has more scenes than the board route returns. */
    isTruncated(guildId: string | null | undefined): boolean {
        return !!guildId && !!this.truncatedGuilds()[guildId];
    }

    scene(guildId: string | null | undefined, channelId: string | null | undefined): SceneDto | null {
        if (!channelId) return null;
        const scene = this.sceneByChannel()[channelId] ?? null;
        return scene && (!guildId || scene.guildId === guildId) ? scene : null;
    }

    /** The scene an out-of-character thread belongs to, so the OOC side can point back. */
    sceneForOoc(
        guildId: string | null | undefined,
        threadId: string | null | undefined,
    ): SceneListItemDto | null {
        if (!threadId) return null;
        return this.scenes(guildId).find(s => s.oocThreadId === threadId) ?? null;
    }

    isLoading(guildId: string | null | undefined): boolean {
        return !!guildId && !!this.loadingGuilds()[guildId];
    }

    /** Every character this reader may speak as here. What "your turn" is resolved against. */
    speakableIds(guildId: string | null | undefined): ReadonlySet<string> {
        return new Set(this.personas.speakable(guildId).map(entry => entry.persona.id));
    }

    /** Board order: waiting on you, then status, then the tightest clock. */
    sorted(guildId: string | null | undefined): SceneListItemDto[] {
        const speakable = this.speakableIds(guildId);
        const now = this.now();
        return [...this.scenes(guildId)].sort((a, b) => compareScenes(a, b, speakable, now));
    }

    waitingOnMe(guildId: string | null | undefined): SceneListItemDto[] {
        const speakable = this.speakableIds(guildId);
        return this.scenes(guildId).filter(scene => isWaitingOnMe(scene, speakable));
    }

    waitingOnMeCount(guildId: string | null | undefined): number {
        return this.waitingOnMe(guildId).length;
    }

    /** Scenes chased twice without an answer. What a GM is told about. */
    stalled(guildId: string | null | undefined): SceneListItemDto[] {
        return this.scenes(guildId).filter(
            scene => scene.status === SceneStatus.Active && (scene.nudgeCount ?? 0) >= 2,
        );
    }

    nudge(channelId: string | null | undefined): SceneNudge | null {
        return channelId ? (this.nudgesByChannel()[channelId] ?? null) : null;
    }

    // ── Loading ─────────────────────────────────────────────────────────────

    ensureGuild(guildId: string | null | undefined, force = false): void {
        if (!guildId) return;
        this.wire();
        this.personas.ensureCast(guildId);
        if (this.requestedGuilds.has(guildId) && !force) return;
        this.requestedGuilds.add(guildId);
        this.loadingGuilds.update(map => ({...map, [guildId]: true}));
        // Both flags default to false on the server, so without them a concluded scene is on the
        // board until the next reload and gone after it.
        this.api.listScenes(guildId, {includeConcluded: true, includeArchived: true}).subscribe({
            next: page => {
                this.byGuild.update(map => ({...map, [guildId]: page.scenes ?? []}));
                this.learnChannels(
                    guildId,
                    (page.scenes ?? []).map(scene => scene.channelId),
                );
                this.truncatedGuilds.update(map => ({...map, [guildId]: !!page.truncated}));
                this.loadingGuilds.update(map => ({...map, [guildId]: false}));
            },
            // Keeps whatever was loaded: a failed refresh must not empty the board.
            error: () => this.loadingGuilds.update(map => ({...map, [guildId]: false})),
        });
    }

    refreshScene(guildId: string, channelId: string): void {
        this.wire();
        this.api.getScene(guildId, channelId).subscribe({
            next: scene => this.absorb(guildId, scene),
            error: () => undefined,
        });
    }

    // ── Writes ──────────────────────────────────────────────────────────────

    create(guildId: string, parentChannelId: string, dto: CreateSceneDto): Observable<SceneDto> {
        return this.api
            .createScene(guildId, parentChannelId, dto)
            .pipe(tap(scene => this.absorb(guildId, scene)));
    }

    update(guildId: string, channelId: string, dto: UpdateSceneDto): Observable<SceneDto> {
        return this.api.updateScene(guildId, channelId, dto).pipe(tap(scene => this.absorb(guildId, scene)));
    }

    addParticipant(guildId: string, channelId: string, dto: AddSceneParticipantDto): Observable<SceneDto> {
        return this.api
            .addParticipant(guildId, channelId, dto)
            .pipe(tap(scene => this.absorb(guildId, scene)));
    }

    removeParticipant(guildId: string, channelId: string, personaId: string): Observable<SceneDto> {
        return this.api
            .removeParticipant(guildId, channelId, personaId)
            .pipe(tap(scene => this.absorb(guildId, scene)));
    }

    advanceTurn(guildId: string, channelId: string, dto: AdvanceTurnDto = {}): Observable<SceneDto> {
        return this.api.advanceTurn(guildId, channelId, dto).pipe(tap(scene => this.absorb(guildId, scene)));
    }

    skipTurn(guildId: string, channelId: string, dto: SkipTurnDto = {}): Observable<SceneDto> {
        return this.api.skipTurn(guildId, channelId, dto).pipe(tap(scene => this.absorb(guildId, scene)));
    }

    // ── Turn tracking ───────────────────────────────────────────────────────

    /**
     * The turn advances server-side when the character whose turn it is posts, and no event says so.
     * Moving the rail here keeps it honest until one exists; the next read corrects any drift.
     */
    notePost(guildId: string | null | undefined, channelId: string, personaId: string | null): void {
        if (!guildId || !personaId) return;
        const scene = this.scene(guildId, channelId);
        if (!scene || scene.status !== SceneStatus.Active) return;
        if (scene.currentTurnPersonaId !== personaId) return;

        const queue = queueFromCurrent(scene).slice(1);
        const next = queue.find(id => !scene.participants.find(p => p.personaId === id)?.isAway) ?? null;
        const spanMs = scene.turnDeadlineAt
            ? new Date(scene.turnDeadlineAt).getTime() - turnStart(scene)
            : null;
        const startedAt = new Date().toISOString();

        this.absorb(guildId, {
            ...scene,
            currentTurnPersonaId: next,
            turnStartedAt: startedAt,
            lastPostAt: startedAt,
            turnNumber:
                scene.turnNumber === null || scene.turnNumber === undefined ? null : scene.turnNumber + 1,
            nudgeCount: 0,
            turnDeadlineAt:
                spanMs && spanMs > 0 ? new Date(Date.now() + spanMs).toISOString() : scene.turnDeadlineAt,
        });
        this.clearNudge(channelId);
    }

    clearNudge(channelId: string): void {
        this.nudgesByChannel.update(map => {
            if (!map[channelId]) return map;
            const next = {...map};
            delete next[channelId];
            return next;
        });
    }

    // ── Cache maintenance ───────────────────────────────────────────────────

    /** Stores a whole scene and refreshes the board row it stands behind. */
    private absorb(guildId: string, scene: SceneDto): void {
        this.learnChannels(guildId, [scene.channelId]);
        this.sceneByChannel.update(map => ({...map, [scene.channelId]: scene}));
        this.byGuild.update(map => {
            const rows = map[guildId] ?? [];
            const at = rows.findIndex(s => s.channelId === scene.channelId);
            const row = rowFromScene(scene, at === -1 ? null : rows[at]);
            return {...map, [guildId]: at === -1 ? [...rows, row] : rows.map((s, i) => (i === at ? row : s))};
        });
    }

    /**
     * Applies a hub patch to both caches. Neither scene event carries the cast or its display data,
     * so a channel nobody has opened has no scene to patch and is left to the next read.
     */
    private patch(guildId: string, channelId: string, patch: Partial<SceneDto>): void {
        const scene = this.scene(guildId, channelId);
        if (scene) {
            this.absorb(guildId, {...scene, ...patch});
            return;
        }

        this.byGuild.update(map => {
            const rows = map[guildId] ?? [];
            const at = rows.findIndex(s => s.channelId === channelId);
            if (at === -1) return map;
            return {...map, [guildId]: rows.map((s, i) => (i === at ? {...s, ...rowPatch(patch)} : s))};
        });
    }

    /**
     * A scene opened. Only boards that have already been read gain the row; one that has not is
     * loaded whole by the next read, and a row invented for it would be the only one on it.
     */
    private noteCreated(event: SceneCreatedDto): void {
        this.learnChannels(event.guildId, [event.channelId]);
        if (!this.requestedGuilds.has(event.guildId)) return;
        this.byGuild.update(map => {
            const rows = map[event.guildId] ?? [];
            if (rows.some(s => s.channelId === event.channelId)) return map;
            return {...map, [event.guildId]: [...rows, rowFromCreated(event)]};
        });
    }

    /**
     * A scene channel is a thread, so the guild's channel list only learns about it on the next read
     * of the guild. Until it does, nothing can open the scene: every surface resolves a scene to a
     * channel through that list.
     */
    private learnChannels(guildId: string, channelIds: readonly string[]): void {
        if (this.learningGuilds.has(guildId)) return;
        const guilds = this.injector.get(GuildService);
        const known = guilds.guilds().find(g => g.id === guildId)?.channels;
        if (!known || channelIds.every(id => known.some(channel => channel.id === id))) return;

        this.learningGuilds.add(guildId);
        guilds.getGuild(guildId).subscribe({
            next: fresh => {
                this.learningGuilds.delete(guildId);
                guilds.upsertGuild(fresh);
                const current = guilds.guilds().find(g => g.id === guildId);
                if (current) this.injector.get(NavigationService).updateCurrentGuild(current);
            },
            error: () => this.learningGuilds.delete(guildId),
        });
    }

    private noteNudge(event: SceneTurnNudgeDto): void {
        this.nudgesByChannel.update(map => ({
            ...map,
            [event.channelId]: {
                channelId: event.channelId,
                personaId: event.personaId,
                sceneName: event.sceneName ?? null,
                receivedAt: Date.now(),
                nudgeCount: event.nudgeCount ?? 1,
                toGameMaster: !!event.escalated,
            },
        }));

        if (this.scenes(event.guildId).some(s => s.channelId === event.channelId)) {
            this.patch(event.guildId, event.channelId, {
                nudgeCount: event.nudgeCount ?? 1,
                turnStartedAt: event.turnStartedAt ?? undefined,
                turnDeadlineAt: event.turnDeadlineAt ?? undefined,
            });
        } else {
            this.ensureGuild(event.guildId, true);
        }
    }
}

/** The board row a scene stands behind. Keeps whatever the row already knew that a scene does not say. */
function rowFromScene(scene: SceneDto, previous: SceneListItemDto | null): SceneListItemDto {
    const current = scene.participants.find(p => p.personaId === scene.currentTurnPersonaId);
    return {
        ...previous,
        channelId: scene.channelId,
        name: scene.name,
        parentChannelId: scene.parentChannelId,
        status: scene.status,
        currentTurnPersonaId: scene.currentTurnPersonaId,
        currentTurnName: current?.name ?? previous?.currentTurnName ?? null,
        currentTurnAvatarUrl: current?.avatarUrl ?? previous?.currentTurnAvatarUrl ?? null,
        currentTurnColor: current?.color ?? previous?.currentTurnColor ?? null,
        turnStartedAt: scene.turnStartedAt,
        turnDeadlineAt: scene.turnDeadlineAt,
        turnNumber: scene.turnNumber,
        postCount: scene.postCount,
        participantCount: scene.participants.length || previous?.participantCount || 0,
        oocThreadId: scene.oocThreadId,
        nudgeCount: scene.nudgeCount,
    };
}

/** The board row a `guild.SceneCreated` stands up. It carries no display data for the cast. */
function rowFromCreated(event: SceneCreatedDto): SceneListItemDto {
    return {
        channelId: event.channelId,
        name: event.name,
        parentChannelId: event.parentChannelId,
        status: event.status,
        currentTurnPersonaId: event.currentTurnPersonaId,
        turnStartedAt: event.turnStartedAt,
        turnDeadlineAt: event.turnDeadlineAt,
        turnNumber: event.turnNumber,
        postCount: 0,
        participantCount: event.participantPersonaIds?.length ?? 0,
        oocThreadId: event.oocThreadId,
        nudgeCount: 0,
    };
}

/** The fields of a scene patch a board row also carries. */
function rowPatch(patch: Partial<SceneDto>): Partial<SceneListItemDto> {
    const {
        status,
        currentTurnPersonaId,
        turnStartedAt,
        turnDeadlineAt,
        turnNumber,
        postCount,
        oocThreadId,
        nudgeCount,
    } = patch;
    return Object.fromEntries(
        Object.entries({
            status,
            currentTurnPersonaId,
            turnStartedAt,
            turnDeadlineAt,
            turnNumber,
            postCount,
            oocThreadId,
            nudgeCount,
        }).filter(([, value]) => value !== undefined),
    );
}

function turnStart(scene: SceneDto): number {
    const raw = scene.turnStartedAt ?? scene.lastPostAt;
    const parsed = raw ? new Date(raw).getTime() : Number.NaN;
    return Number.isNaN(parsed) ? Date.now() : parsed;
}
