import {DestroyRef, inject, Injectable, Injector, signal} from '@angular/core';
import {Subject} from 'rxjs';
import {debounceTime, groupBy, mergeMap} from 'rxjs/operators';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {DraftApi} from './draft-api.service';
import {MessageDraftDto} from '../dtos/response/draft.dto';

/** How long typing has to stop before the draft goes up. */
const SAVE_DEBOUNCE_MS = 1_200;

export type DraftSaveState = 'idle' | 'saving' | 'saved' | 'failed';

/**
 * Unsent messages, per channel, held by the server so a refresh cannot take one away.
 *
 * Saving is debounced per channel rather than globally, so typing in one channel never delays the
 * save of another that was left mid-sentence.
 */
@Injectable({providedIn: 'root'})
export class DraftService {
    private readonly injector = inject(Injector);
    private readonly destroyRef = inject(DestroyRef);

    private readonly drafts = signal<Record<string, MessageDraftDto | null>>({});
    private readonly loaded = signal<Record<string, boolean>>({});
    private readonly saveState = signal<Record<string, DraftSaveState>>({});

    private readonly pending = new Subject<{channelId: string; content: string}>();
    private readonly requested = new Set<string>();
    private indexRequested = false;

    constructor() {
        this.pending
            .pipe(
                groupBy(entry => entry.channelId),
                mergeMap(group => group.pipe(debounceTime(SAVE_DEBOUNCE_MS))),
                takeUntilDestroyed(this.destroyRef),
            )
            .subscribe(entry => this.flush(entry.channelId, entry.content));
    }

    private get api(): DraftApi {
        return this.injector.get(DraftApi);
    }

    /** What the server holds for this channel, or null once it is known to hold nothing. */
    draft(channelId: string | null | undefined): MessageDraftDto | null {
        return channelId ? (this.drafts()[channelId] ?? null) : null;
    }

    isLoaded(channelId: string | null | undefined): boolean {
        return !!channelId && !!this.loaded()[channelId];
    }

    /** Drives the pencil beside a channel that has something waiting in it. */
    hasDraft(channelId: string | null | undefined): boolean {
        return !!this.draft(channelId)?.content.trim();
    }

    state(channelId: string | null | undefined): DraftSaveState {
        return channelId ? (this.saveState()[channelId] ?? 'idle') : 'idle';
    }

    /** The whole set, once, so the channel list can mark channels nobody has opened this session. */
    ensureIndex(): void {
        if (this.indexRequested) return;
        this.indexRequested = true;
        this.api.list().subscribe({
            next: rows => {
                this.drafts.update(map => {
                    const next = {...map};
                    for (const row of rows) {
                        // A channel already read individually holds the fresher answer.
                        if (!(row.contextId in next)) next[row.contextId] = row;
                    }
                    return next;
                });
            },
            error: () => (this.indexRequested = false),
        });
    }

    ensureLoaded(channelId: string | null | undefined): void {
        this.ensureIndex();
        if (!channelId || this.requested.has(channelId)) return;
        this.requested.add(channelId);
        this.api.get(channelId).subscribe({
            next: draft => {
                this.drafts.update(map => ({...map, [channelId]: draft}));
                this.loaded.update(map => ({...map, [channelId]: true}));
            },
            // Leaves it unloaded so the composer never claims "nothing was saved" on a failed read.
            error: () => this.requested.delete(channelId),
        });
    }

    /** Called on every keystroke. The write itself is debounced. */
    record(channelId: string | null | undefined, content: string): void {
        if (!channelId) return;
        this.saveState.update(map => ({...map, [channelId]: 'saving'}));
        this.pending.next({channelId, content});
    }

    /** Writes now rather than on the debounce, for a view about to go away. */
    flushNow(channelId: string | null | undefined, content: string): void {
        if (!channelId) return;
        this.flush(channelId, content);
    }

    /** After a successful send, and when somebody throws the draft away by hand. */
    clear(channelId: string | null | undefined): void {
        if (!channelId) return;
        this.drafts.update(map => ({...map, [channelId]: null}));
        this.saveState.update(map => ({...map, [channelId]: 'idle'}));
        this.api.discard(channelId).subscribe({error: () => undefined});
    }

    private flush(channelId: string, content: string): void {
        if (!content.trim()) {
            this.clear(channelId);
            return;
        }

        this.api.save(channelId, {content}).subscribe({
            next: draft => {
                this.drafts.update(map => ({...map, [channelId]: draft}));
                this.saveState.update(map => ({...map, [channelId]: 'saved'}));
            },
            error: () => this.saveState.update(map => ({...map, [channelId]: 'failed'})),
        });
    }
}
