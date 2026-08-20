import {inject, Injectable, signal} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {WikiGraphDto} from '../../../../../dtos/response/wiki.dto';
import {WikiService} from '../../../../../services/wiki.service';

/**
 * The link map for a guild, straight from the server. One small request, no page bodies.
 *
 * Held per guild rather than per view so the home page preview and the full graph share the one
 * fetch.
 */
@Injectable({providedIn: 'root'})
export class WikiGraphSourceService {
    private readonly byGuild = signal<ReadonlyMap<string, WikiGraphDto>>(new Map());
    private readonly isLoading = signal(false);
    private readonly didFail = signal(false);
    private readonly isAbsent = signal(false);

    readonly graphs = this.byGuild.asReadonly();
    readonly loading = this.isLoading.asReadonly();
    readonly failed = this.didFail.asReadonly();
    /** The server answered 404: this instance has no graph endpoint, so callers need the fallback. */
    readonly absent = this.isAbsent.asReadonly();

    private readonly wikiService = inject(WikiService);
    private readonly inFlight = new Set<string>();

    /** Fetches once per guild per session. */
    load(guildId: string): void {
        if (this.byGuild().has(guildId)) return;
        this.fetch(guildId);
    }

    /** Fetches even when a copy is already held. Edges change on every page edit. */
    refresh(guildId: string): void {
        this.fetch(guildId);
    }

    private fetch(guildId: string): void {
        if (!guildId || this.inFlight.has(guildId)) return;
        this.inFlight.add(guildId);
        this.isLoading.set(true);
        this.didFail.set(false);
        this.wikiService.getGraph(guildId).subscribe({
            next: graph => {
                this.byGuild.update(map => new Map(map).set(guildId, graph));
                this.settle(guildId);
                this.isAbsent.set(false);
            },
            error: (error: unknown) => {
                this.settle(guildId);
                // 404 is the endpoint missing, not an empty wiki: only that case may fall back.
                if (error instanceof HttpErrorResponse && error.status === 404) this.isAbsent.set(true);
                else this.didFail.set(true);
            },
        });
    }

    private settle(guildId: string): void {
        this.inFlight.delete(guildId);
        this.isLoading.set(this.inFlight.size > 0);
    }
}
