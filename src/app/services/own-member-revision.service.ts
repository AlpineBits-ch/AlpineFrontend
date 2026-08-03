import {inject, Injectable, signal} from '@angular/core';
import {GuildWebsocketService} from './guild-websocket.service';
import {ProfileService} from './profile.service';

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
 * constructor would make every one of them fail to construct it.</p>
 */
@Injectable({providedIn: 'root'})
export class OwnMemberRevisionService {
    private readonly _revision = signal(0);

    private readonly guildWs = inject(GuildWebsocketService);
    private readonly profiles = inject(ProfileService);

    constructor() {
        // Only our own row moves a permission gate. Someone else's promotion changes what the
        // member list renders - which listens for the event in its own right - and nothing this
        // client is allowed to do, so bumping on it would re-read `/me` once per member of a busy
        // guild for no change at all.
        this.guildWs.memberUpdatedObservable.subscribe(event => {
            if (event.userId !== this.profiles.ownProfile()?.userId) return;
            this._revision.update(n => n + 1);
        });
    }

    /** Read this in an `effect` that fetches the own-member row; it changes when the row does. */
    readonly revision = this._revision.asReadonly();
}
