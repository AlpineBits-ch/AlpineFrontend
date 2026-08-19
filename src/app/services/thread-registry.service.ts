import {computed, inject, Injectable, signal} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {catchError, map, Observable, of, throwError} from 'rxjs';
import {ChannelDto} from '../dtos/response/guild.dto';
import {CreateThreadDto} from '../dtos/request/create-thread.dto';
import {GuildService} from './guild.service';
import {GuildWebsocketService} from './guild-websocket.service';
import {NavigationService} from '../features/main-page/navigation.service';

/**
 * The one place a thread channel is looked up. The guild payload carries forum posts and may or may
 * not carry text-channel threads, so anything missing is fetched once and kept here.
 */
@Injectable({providedIn: 'root'})
export class ThreadRegistryService {
    private readonly guildService = inject(GuildService);
    private readonly ws = inject(GuildWebsocketService);
    private readonly navService = inject(NavigationService);

    /** Fetched threads by id. The guild payload is read live and never copied in here. */
    private readonly fetched = signal<Record<string, ChannelDto>>({});
    /** Ids already asked for, including ones that 404ed, so a dead pointer isn't retried on every redraw. */
    private readonly asked = new Set<string>();
    private readonly askedParents = new Set<string>();

    private readonly payloadThreads = computed(() => {
        const ws = this.navService.workspace();
        if (ws.type !== 'server') return [] as ChannelDto[];
        return ws.guild.channels.filter(c => !!c.parentChannelId);
    });

    constructor() {
        this.ws.threadCreatedObservable.subscribe(e => this.ensureThread(e.channelId));
        this.ws.messageThreadAttachedObservable.subscribe(e => this.ensureThread(e.threadId));
        this.ws.threadUpdatedObservable.subscribe(e => {
            const held = this.fetched()[e.channelId];
            if (!held) return;
            // Full current state, not a patch: each present field replaces.
            this.upsert({
                ...held,
                name: e.name ?? held.name,
                isPinned: e.isPinned ?? held.isPinned,
                isLocked: e.isLocked ?? held.isLocked,
                isArchived: e.isArchived ?? held.isArchived,
                tagIds: e.tagIds ?? held.tagIds,
            });
        });
    }

    thread(threadId: string): ChannelDto | null {
        return this.payloadThreads().find(c => c.id === threadId) ?? this.fetched()[threadId] ?? null;
    }

    threadsFor(parentId: string): ChannelDto[] {
        const byId = new Map<string, ChannelDto>();
        for (const c of this.payloadThreads()) if (c.parentChannelId === parentId) byId.set(c.id, c);
        for (const c of Object.values(this.fetched())) if (c.parentChannelId === parentId) byId.set(c.id, c);
        return [...byId.values()];
    }

    ensureThread(threadId: string): void {
        if (!threadId || this.asked.has(threadId) || this.thread(threadId)) return;
        this.asked.add(threadId);
        this.guildService.getChannel(threadId).subscribe({
            next: channel => this.upsert(channel),
            // A threadId resolving to nothing is expected: the thread was deleted, or a create
            // failed after the message had already been stamped.
            error: () => {},
        });
    }

    ensureParent(parentId: string): void {
        if (!parentId || this.askedParents.has(parentId)) return;
        this.askedParents.add(parentId);
        this.guildService.getThreads(parentId).subscribe({
            next: threads => threads.forEach(t => this.upsert(t)),
            error: () => {},
        });
    }

    upsert(channel: ChannelDto): void {
        this.asked.add(channel.id);
        this.fetched.update(map => ({...map, [channel.id]: channel}));
    }

    /** Answers the thread id either way: a 409 means someone else pressed the button first. */
    createFromMessage(channelId: string, messageId: string, dto: CreateThreadDto): Observable<string> {
        return this.guildService.createThreadFromMessage(channelId, messageId, dto).pipe(
            map(thread => {
                this.upsert(thread);
                return thread.id;
            }),
            catchError((err: HttpErrorResponse) => {
                const existing = (err.error as {threadId?: string} | null)?.threadId;
                if (err.status === 409 && existing) {
                    this.ensureThread(existing);
                    return of(existing);
                }
                return throwError(() => err);
            }),
        );
    }
}
