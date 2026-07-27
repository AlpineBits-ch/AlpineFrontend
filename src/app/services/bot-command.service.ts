import {computed, effect, inject, Injectable, signal} from '@angular/core';
import {HttpClient, HttpErrorResponse} from '@angular/common/http';
import {catchError, filter, map, Observable, race, Subject, switchMap, take, tap, throwError, timeout} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {BotCommandDto} from '../dtos/response/bot-command.dto';
import {InvokeBotCommandDto} from '../dtos/request/invoke-bot-command.dto';
import {GuildWebsocketService} from './guild-websocket.service';
import {NavigationService} from '../features/main-page/navigation.service';

/** Thrown by {@link BotCommandService.awaitBotResponse} when no reply arrives from the bot in time. */
export class BotCommandTimeoutError extends Error {
    constructor() {
        super('Bot did not respond in time');
    }
}

@Injectable({providedIn: 'root'})
export class BotCommandService {
    private http = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);
    private guildWs = inject(GuildWebsocketService);
    private navService = inject(NavigationService);

    /** Cancels any older in-flight `awaitBotResponse` wait for the same (channelId, botUserId) pair. */
    private readonly inFlightWaits = new Map<string, Subject<void>>();

    // ── Per-guild bot roster cache, used to resolve bot display names (e.g. in messages) ──
    private readonly commandsByGuild = signal<Record<string, BotCommandDto[]>>({});
    /** Installed-bot roster for the guild currently open in the workspace, if any. */
    readonly currentGuildBots = computed<BotCommandDto[]>(() => {
        const ws = this.navService.workspace();
        return ws.type === 'server' ? (this.commandsByGuild()[ws.guild.id] ?? []) : [];
    });

    constructor() {
        effect(() => {
            const ws = this.navService.workspace();
            if (ws.type === 'server') this.loadCommandsForGuild(ws.guild.id);
        });
        this.guildWs.botInstalledObservable.subscribe(e => this.loadCommandsForGuild(e.guildId));
        this.guildWs.botUninstalledObservable.subscribe(e => this.loadCommandsForGuild(e.guildId));
    }

    private loadCommandsForGuild(guildId: string): void {
        this.getCommands(guildId).subscribe({
            next: cmds => this.commandsByGuild.update(c => ({...c, [guildId]: cmds})),
            error: () => this.commandsByGuild.update(c => ({...c, [guildId]: []})),
        });
    }

    private base(): string {
        return `${this.apiConfig.baseUrl()}/api/v1/bots`;
    }

    getCommands(guildId: string): Observable<BotCommandDto[]> {
        return this.http.get<BotCommandDto[]>(`${this.base()}/guilds/${guildId}/commands`);
    }

    invokeCommand(guildId: string, channelId: string, dto: InvokeBotCommandDto): Observable<void> {
        return this.http.post<void>(`${this.base()}/guilds/${guildId}/channels/${channelId}/interactions`, dto);
    }

    /** A 404 can mean the bot isn't installed, or that our cached command list is just stale -
     *  refetch discovery once and retry before surfacing an error. `onCommandsRefetched` lets the
     *  caller (the composer, which owns its own per-guild command cache) refresh in step. */
    invokeCommandWithRetry(
        guildId: string,
        channelId: string,
        dto: InvokeBotCommandDto,
        onCommandsRefetched?: (commands: BotCommandDto[]) => void,
    ): Observable<void> {
        return this.invokeCommand(guildId, channelId, dto).pipe(
            catchError(err => {
                if (!(err instanceof HttpErrorResponse) || err.status !== 404) return throwError(() => err);
                return this.getCommands(guildId).pipe(
                    tap(commands => onCommandsRefetched?.(commands)),
                    switchMap(() => this.invokeCommand(guildId, channelId, dto)),
                );
            }),
        );
    }

    /**
     * Resolves when the bot's reply lands in the channel (as a normal `guild.MessageCreated`
     * event), or errors with {@link BotCommandTimeoutError} if nothing arrives in time. There's
     * no interaction/correlation ID in the API, so this can only match on (channelId, botUserId) -
     * starting a new wait for the same pair cancels the previous one so a stray reply can't
     * silently clear an unrelated, still-unanswered invocation's placeholder.
     */
    awaitBotResponse(channelId: string, botUserId: string, timeoutMs = 10_000): Observable<void> {
        const key = `${channelId}:${botUserId}`;
        this.inFlightWaits.get(key)?.next();
        const cancel = new Subject<void>();
        this.inFlightWaits.set(key, cancel);

        const matched$ = this.guildWs.messageObservable.pipe(
            filter(msg => msg.channelId === channelId && msg.authorId === botUserId),
            take(1),
            map(() => void 0),
        );
        const cancelled$ = cancel.pipe(
            take(1),
            switchMap(() => throwError(() => new BotCommandTimeoutError())),
        );

        return race(matched$, cancelled$).pipe(
            timeout(timeoutMs),
            catchError(() => throwError(() => new BotCommandTimeoutError())),
        );
    }
}
