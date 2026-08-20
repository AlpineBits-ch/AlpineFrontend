import {DestroyRef, inject, Injectable, Injector, signal} from '@angular/core';
import {Subject, Subscription} from 'rxjs';
import {debounceTime, groupBy, mergeMap} from 'rxjs/operators';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {DraftApi} from './draft-api.service';
import {MessageDraftDto} from '../dtos/response/draft.dto';

/** How long typing has to stop before the draft goes up. */
const SAVE_DEBOUNCE_MS = 1_200;

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

    private readonly pending = new Subject<{
        channelId: string;
        content: string;
        attachments: string[];
        epoch: number;
    }>();
    private readonly requested = new Set<string>();
    /** Bumped by {@link clear}. Anything recorded under an older one is no longer wanted. */
    private readonly epochs = new Map<string, number>();
    private readonly inFlight = new Map<string, Subscription>();
    private indexRequested = false;

    constructor() {
        this.pending
            .pipe(
                groupBy(entry => entry.channelId),
                mergeMap(group => group.pipe(debounceTime(SAVE_DEBOUNCE_MS))),
                takeUntilDestroyed(this.destroyRef),
            )
            .subscribe(entry => this.flush(entry.channelId, entry.content, entry.attachments, entry.epoch));
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
        const draft = this.draft(channelId);
        return !!draft?.content.trim() || !!draft?.attachments?.length;
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
    record(channelId: string | null | undefined, content: string, attachments: string[] = []): void {
        if (!channelId) return;
        this.pending.next({channelId, content, attachments, epoch: this.epochOf(channelId)});
    }

    /** Writes now rather than on the debounce, for a view about to go away. */
    flushNow(channelId: string | null | undefined, content: string, attachments: string[] = []): void {
        if (!channelId) return;
        this.flush(channelId, content, attachments, this.epochOf(channelId));
    }

    /** After a successful send, and when somebody throws the draft away by hand. */
    clear(channelId: string | null | undefined): void {
        if (!channelId) return;
        // Enter usually beats the debounce, so the keystrokes that made the post are still queued
        // for a save. The bump makes that write, and any save already on the wire, land nowhere.
        this.epochs.set(channelId, this.epochOf(channelId) + 1);
        this.inFlight.get(channelId)?.unsubscribe();
        this.inFlight.delete(channelId);
        this.drafts.update(map => ({...map, [channelId]: null}));
        this.api.discard(channelId).subscribe({error: () => undefined});
    }

    private epochOf(channelId: string): number {
        return this.epochs.get(channelId) ?? 0;
    }

    private flush(channelId: string, content: string, attachments: string[], epoch: number): void {
        if (epoch !== this.epochOf(channelId)) return;

        // An attachment with no text is still a draft: losing the upload is what costs somebody
        // the transfer, not losing the sentence they had not written yet.
        if (!content.trim() && attachments.length === 0) {
            this.clear(channelId);
            return;
        }

        this.inFlight.get(channelId)?.unsubscribe();
        const sub = this.api.save(channelId, {content, attachments}).subscribe({
            next: draft => {
                this.inFlight.delete(channelId);
                if (epoch !== this.epochOf(channelId)) return;
                this.drafts.update(map => ({...map, [channelId]: draft}));
            },
            error: () => this.inFlight.delete(channelId),
        });
        this.inFlight.set(channelId, sub);
    }
}
