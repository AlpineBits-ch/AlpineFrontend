import {computed, inject, Injectable, Signal, signal, untracked} from '@angular/core';
import {GuildService} from '../../../services/guild.service';
import {EffectivePermissionsDto} from '../../../dtos/response/effective-permissions.dto';
import {hasPermission, parsePermissions, PermissionValue} from '../../../enums/permissions.enum';

export interface ViewAsSubject {
    kind: 'role' | 'member';
    id: string;
    name: string;
    color?: string;
}

/**
 * A preview of the guild through someone else's permissions.
 *
 * Nothing on a write path may read this. It changes what is drawn, never what is permitted, and
 * every affordance it touches is disabled with a reason rather than removed.
 */
@Injectable({providedIn: 'root'})
export class ViewAsService {
    private readonly subjects = signal<Record<string, ViewAsSubject>>({});
    private readonly traces = signal<Record<string, EffectivePermissionsDto>>({});
    private readonly inFlight = new Set<string>();

    private readonly guildService = inject(GuildService);

    subject(guildId: string): Signal<ViewAsSubject | null> {
        return computed(() => this.subjects()[guildId] ?? null);
    }

    active(guildId: string): Signal<boolean> {
        return computed(() => this.subjects()[guildId] !== undefined);
    }

    enter(guildId: string, subject: ViewAsSubject): void {
        this.clearGuild(guildId);
        this.subjects.update(map => ({...map, [guildId]: subject}));
    }

    exit(guildId: string): void {
        this.subjects.update(map => {
            const next = {...map};
            delete next[guildId];
            return next;
        });
        this.clearGuild(guildId);
    }

    traceFor(guildId: string, channelId: string): Signal<EffectivePermissionsDto | null> {
        return computed(() => this.traces()[this.key(guildId, channelId)] ?? null);
    }

    /**
     * Fetches one channel's trace, once. Safe to call from a template-driven render.
     *
     * The guard reads are untracked: a caller driving this from an effect (the channel list does,
     * once per channel) must not pick up `subjects`/`traces` as dependencies through this call, or
     * every trace landing would re-run that effect over every channel again.
     */
    request(guildId: string, channelId: string): void {
        const subject = untracked(() => this.subjects()[guildId]);
        if (!subject) return;

        const key = this.key(guildId, channelId);
        if (untracked(() => this.traces()[key]) || this.inFlight.has(key)) return;

        this.inFlight.add(key);
        this.guildService.getEffectivePermissions(channelId, {kind: subject.kind, id: subject.id}).subscribe({
            next: dto => {
                this.inFlight.delete(key);
                this.traces.update(map => ({...map, [key]: dto}));
            },
            error: () => this.inFlight.delete(key),
        });
    }

    /** False while the trace is unknown: an unresolved channel reads as inaccessible, not as open. */
    can(guildId: string, channelId: string, permission: PermissionValue): boolean {
        const dto = this.traces()[this.key(guildId, channelId)];
        if (!dto) return false;
        return hasPermission(parsePermissions(dto.permissions), permission);
    }

    private clearGuild(guildId: string): void {
        const prefix = `${guildId}:`;
        this.traces.update(map =>
            Object.fromEntries(Object.entries(map).filter(([key]) => !key.startsWith(prefix))),
        );
        for (const key of [...this.inFlight]) {
            if (key.startsWith(prefix)) this.inFlight.delete(key);
        }
    }

    private key(guildId: string, channelId: string): string {
        return `${guildId}:${channelId}`;
    }
}
