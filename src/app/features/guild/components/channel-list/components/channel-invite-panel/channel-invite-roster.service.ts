import {inject, Injectable} from '@angular/core';
import {forkJoin, Observable, of} from 'rxjs';
import {catchError, shareReplay} from 'rxjs/operators';
import {GuildMemberDto} from '../../../../../../dtos/response/member.dto';
import {GuildService} from '../../../../../../services/guild.service';

/** Everything the panel needs to decide who it may offer. */
export interface ChannelRoster {
    members: GuildMemberDto[];
    /** Whose `ViewChannel` the server confirms. Empty means the read failed - see below. */
    viewers: string[];
}

/**
 * Sixty seconds. Long enough that hovering the menu twice while deciding costs one pair of reads,
 * short enough that somebody who just came online is offered the next time the panel is opened.
 */
const TTL_MS = 60_000;

/**
 * The two reads behind the quick invite panel, held briefly.
 *
 * <p><b>Why a cache at all, when the picker dialog happily refetches on every open.</b> The dialog
 * opens when somebody decides to open it. This panel opens on hover - passing over the Invite item
 * on the way to Delete Channel opens it - so the same pair of reads would otherwise fire several
 * times in the seconds it takes to read a menu.</p>
 *
 * <p>Both reads collapse to empty rather than failing. An empty viewer list offers nobody, which
 * shows the empty state instead of a roster the server would refuse one name at a time.</p>
 */
@Injectable({providedIn: 'root'})
export class ChannelInviteRosterService {
    private readonly guildService = inject(GuildService);
    private readonly cache = new Map<string, {at: number; roster$: Observable<ChannelRoster>}>();

    load(guildId: string, channelId: string): Observable<ChannelRoster> {
        const cached = this.cache.get(channelId);
        if (cached && Date.now() - cached.at < TTL_MS) return cached.roster$;

        // shareReplay rather than a stored value: two opens inside the same tick then share one
        // pair of requests instead of racing each other to fill the same entry.
        const roster$ = forkJoin({
            viewers: this.guildService.getChannelViewers(channelId)
                .pipe(catchError(() => of([] as string[]))),
            members: this.guildService.getMembers(guildId, 0, 200)
                .pipe(catchError(() => of([] as GuildMemberDto[]))),
        }).pipe(shareReplay({bufferSize: 1, refCount: false}));

        this.cache.set(channelId, {at: Date.now(), roster$});
        return roster$;
    }

    /** Forgets a channel's copy, so the next open pays for a fresh read. */
    invalidate(channelId: string): void {
        this.cache.delete(channelId);
    }
}
