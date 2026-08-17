import {computed, effect, inject, Injectable, signal} from '@angular/core';
import {Activity, MAX_ACTIVITIES, primaryActivity} from '../models/activity.model';
import {GuildMemberDto} from '../dtos/response/member.dto';
import {ProfileService} from './profile.service';

/**
 * Who is doing what, keyed by user id — the one store every rich-presence surface reads.
 *
 * <p><b>Why a separate store and not a field on `ProfileDto`.</b> Activity arrives from two places
 * with different shapes and different lifetimes: the member list hydrates it in bulk off
 * `GuildMemberDto.activities`, and `guild.PresenceChanged` replaces it per user thereafter. A
 * profile is a cached document with an avatar and a bio; activity is a live, high-churn, per-user
 * fact with a 300 s server-side TTL behind it. Folding one into the other would mean a presence
 * event either rewriting cached profile documents or being dropped for every user whose profile has
 * not been fetched — which is exactly the pre-existing hole in
 * {@link ProfileService.setOnlineStatus}, where an uncached user's status update is silently
 * discarded. Keyed by user id and independent of the profile cache, nothing here can be lost that
 * way.</p>
 *
 * <p>Everything in here has already been filtered server-side by `ProjectActivitiesFor` — blocks,
 * the subject's `shareActivity`, a `Hidden` status, and the per-application opt-out list. There is
 * no client-side gating to do and none should be added: a client-side privacy check is not a
 * privacy control.</p>
 */
@Injectable({providedIn: 'root'})
export class UserActivityService {
    private readonly profiles = inject(ProfileService);

    private readonly byUserId = signal<Record<string, Activity[]>>({});

    /** The signed-in user's own activities, as the server sees them. */
    readonly own = computed(() => {
        const userId = this.profiles.ownProfile()?.userId;
        return userId ? (this.byUserId()[userId] ?? []) : [];
    });

    constructor() {
        // Sign-out and account switch both surface as the profile going away. Without this the next
        // account inherits the previous one's roster of "playing" labels until each is individually
        // superseded - and for anybody who has since gone offline, forever.
        let lastUserId: string | null = null;
        effect(() => {
            const userId = this.profiles.ownProfile()?.userId ?? null;
            if (userId === lastUserId) return;
            lastUserId = userId;
            if (userId === null) this.clear();
        });
    }

    /** Everything the viewer is allowed to see for one user. Empty when there is nothing. */
    activitiesFor(userId: string | null | undefined): Activity[] {
        if (!userId) return [];
        return this.byUserId()[userId] ?? [];
    }

    /** The one activity a single-line surface should render, or null. */
    primaryFor(userId: string | null | undefined): Activity | null {
        return primaryActivity(this.activitiesFor(userId));
    }

    /**
     * Replaces one user's activities wholesale.
     *
     * <p>Replace rather than merge: `guild.PresenceChanged` carries the complete post-change list,
     * so merging would make "stopped playing" unrepresentable — an empty list is the only way the
     * server can say a game ended, and a merge would read it as "no news".</p>
     */
    set(userId: string, activities: Activity[] | null | undefined): void {
        const next = (activities ?? []).slice(0, MAX_ACTIVITIES);
        const current = this.byUserId()[userId];

        // Cheap identity guard. Presence refreshes land on every heartbeat for every member of
        // every shared guild, and the overwhelming majority carry the activity list unchanged;
        // writing the signal anyway would repaint every member list in the app on each one.
        if ((current?.length ?? 0) === 0 && next.length === 0) return;

        this.byUserId.update(map => {
            if (next.length === 0) {
                const {[userId]: _dropped, ...rest} = map;
                return rest;
            }
            return {...map, [userId]: next};
        });
    }

    /**
     * Seeds from a page of members.
     *
     * <p>Members whose `activities` is absent are skipped rather than cleared: the field is optional
     * until the backend ships it, and treating "the server did not say" as "nothing is playing"
     * would have every roster fetch wipe presence that arrived over the socket a moment earlier.</p>
     */
    seedFromMembers(members: readonly GuildMemberDto[]): void {
        for (const member of members) {
            if (member.activities === undefined) continue;
            this.set(member.userId, member.activities);
        }
    }

    clear(): void {
        this.byUserId.set({});
    }
}
