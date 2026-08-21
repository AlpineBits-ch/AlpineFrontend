import {inject, Injectable, signal} from '@angular/core';
import {merge} from 'rxjs';
import {GuildService} from './guild.service';
import {ProfileService} from './profile.service';
import {RealtimeConnectionService} from './realtime-connection.service';

/**
 * "Your own member row has changed - read it again."
 *
 * <p><b>Why anything needs this.</b> Every permission gate in the guild UI is computed from the
 * roles on `GET /guilds/{id}/me`: who may create a channel or a category, who sees Server
 * Settings, who may move people between voice channels, who may lock a forum post. That row is
 * fetched once when a guild is opened and then never again, and `guild.MemberUpdated` - the event
 * that fires when someone's roles or nickname change - had no listener at all. A demotion
 * therefore left the manage controls on screen until the next launch, where every press failed
 * against a server that had already said no; a promotion left the user holding a permission with
 * no visible way to use it.</p>
 *
 * <p><b>A counter, not the row.</b> The payload names *who* changed and never *what* - roles come
 * through with `nickname` unchanged - so re-reading is the only correct response, and there is
 * nothing to patch a cached row with. Each host already owns the copy it renders from, keyed by
 * the guild it is showing, so all that was missing was a reason to fetch again: read
 * {@link revision} inside the `effect` that calls `getOwnMember` and the fetch repeats.</p>
 *
 * <p>Separate from `GuildService` on purpose. That service is injected by specs that provide only
 * an HTTP client, and pulling the realtime connection (and through it the OAuth client) into its
 * constructor would make every one of them fail to construct it. The dependency therefore runs
 * this way round - this service knows about `GuildService`, never the reverse - which is also why
 * cache invalidation is a plain method there that this calls, rather than a listener there.</p>
 */
@Injectable({providedIn: 'root'})
export class OwnMemberRevisionService {
    private readonly _revision = signal(0);

    private readonly realtime = inject(RealtimeConnectionService);
    private readonly profiles = inject(ProfileService);
    private readonly guilds = inject(GuildService);

    constructor() {
        // Only our own row moves a permission gate. Someone else's promotion changes what the
        // member list renders - which listens for the event in its own right - and nothing this
        // client is allowed to do, so bumping on it would re-read `/me` once per member of a busy
        // guild for no change at all.
        this.realtime.stream('guild.MemberUpdated').subscribe(event => {
            if (event.userId !== this.profiles.ownProfile()?.userId) return;
            // Invalidate first, bump second. The bump is the instruction to re-read, and the hosts
            // that obey it call `getOwnMember` - which is cached now. Left populated, that cache
            // would answer every one of those re-reads with the row from before the change, so the
            // demotion this service exists to deliver would go through the motions and change
            // nothing. Ordering it this way needs no argument about when effects run.
            this.guilds.invalidateOwnMember(event.guildId);
            this._revision.update(n => n + 1);
        });

        // Removal and rejoin: the cached row is wrong afterwards either way - a removal ends the
        // membership it describes, and a rejoin starts a fresh one with default roles - and a
        // rejoin inside the cache's lifetime would otherwise be handed the roles the old
        // membership had.
        //
        // Deliberately no revision bump. The bump asks every mounted host to re-read, and after a
        // removal every one of those reads is a 404; the guild view is being torn down anyway.
        // Dropping the entry is enough: whatever reads next reads the truth.
        merge(
            this.realtime.stream('guild.MemberKicked'),
            this.realtime.stream('guild.MemberBanned'),
            this.realtime.stream('guild.MemberLeft'),
            this.realtime.stream('guild.MemberMovedOut'),
            this.realtime.stream('guild.MemberJoined'),
        ).subscribe(event => {
            if (event.userId !== this.profiles.ownProfile()?.userId) return;
            this.guilds.invalidateOwnMember(event.guildId);
        });
    }

    /** Read this in an `effect` that fetches the own-member row; it changes when the row does. */
    readonly revision = this._revision.asReadonly();
}
