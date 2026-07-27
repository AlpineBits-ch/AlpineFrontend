import {Component, inject, input, OnInit, signal} from '@angular/core';
import {DatePipe} from '@angular/common';
import {GuildDto} from '../../../../../../dtos/response/guild.dto';
import {AuditLogEntryDto} from '../../../../../../dtos/response/audit-log-entry.dto';
import {ProfileDto} from '../../../../../../dtos/response/profile.dto';
import {GuildService} from '../../../../../../services/guild.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {ToastService} from '../../../../../../services/toast.service';

interface AuditRow {
    entry: AuditLogEntryDto;
    actorProfile: ProfileDto | null;
    targetProfile: ProfileDto | null;
    metadata: Record<string, unknown> | null;
}

const USER_TARGET_ACTIONS = new Set([
    'MemberBanned', 'MemberUnbanned', 'MemberKicked', 'MemberMuted', 'MemberUnmuted',
]);

@Component({
    selector: 'app-audit-log-settings',
    imports: [DatePipe],
    templateUrl: './audit-log-settings.component.html',
})
export class AuditLogSettingsComponent implements OnInit {
    guild = input.required<GuildDto>();
    rows = signal<AuditRow[]>([]);
    loading = signal(true);
    loadingMore = signal(false);
    hasMore = signal(true);
    private readonly TAKE = 50;
    private nextSkip = 0;
    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);
    private toastService = inject(ToastService);

    ngOnInit(): void {
        this.load();
    }

    load(): void {
        this.loading.set(true);
        this.nextSkip = 0;
        this.hasMore.set(true);
        this.rows.set([]);
        this.fetchPage();
    }

    loadMore(): void {
        if (this.loadingMore() || !this.hasMore() || this.loading()) return;
        this.loadingMore.set(true);
        this.fetchPage();
    }

    onScroll(event: Event): void {
        const el = event.target as HTMLElement;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 150) this.loadMore();
    }

    actorName(row: AuditRow): string {
        return row.actorProfile?.userName ?? row.entry.actorUserId.slice(0, 8) + '…';
    }

    describe(row: AuditRow): string {
        const entry = row.entry;
        const target = this.targetLabel(row);
        switch (entry.actionType) {
            case 'MemberBanned': return target ? `banned ${target}` : 'banned a member';
            case 'MemberUnbanned': return target ? `unbanned ${target}` : 'unbanned a member';
            case 'MemberKicked': return target ? `kicked ${target}` : 'kicked a member';
            case 'MemberMuted': return target ? `timed out ${target}` : 'timed out a member';
            case 'MemberUnmuted': return target ? `removed a timeout from ${target}` : 'removed a timeout';
            case 'MemberLeft': return 'left the server';
            case 'RoleCreated': return target ? `created the role "${target}"` : 'created a role';
            case 'RoleUpdated': return target ? `updated the role "${target}"` : 'updated a role';
            case 'RoleDeleted': return target ? `deleted the role "${target}"` : 'deleted a role';
            case 'RolePositionsChanged': return 'reordered roles';
            case 'ChannelCreated': return target ? `created the channel #${target}` : 'created a channel';
            case 'ChannelDeleted': return target ? `deleted the channel #${target}` : 'deleted a channel';
            case 'ChannelUpdated': return target ? `updated the channel #${target}` : 'updated a channel';
            case 'ChannelPermissionChanged': return target ? `changed permissions for #${target}` : 'changed channel permissions';
            case 'CategoryCreated': return target ? `created the category "${target}"` : 'created a category';
            case 'CategoryDeleted': return target ? `deleted the category "${target}"` : 'deleted a category';
            case 'GuildUpdated': return 'updated server settings';
            case 'GuildDeleted': return 'deleted the server';
            case 'InviteCreated': return 'created an invite';
            case 'InviteDeleted': return 'deleted an invite';
            default: return entry.actionType;
        }
    }

    /** Compact "key: value" summary of the entry's metadata, or null if empty/absent. */
    metadataSummary(row: AuditRow): string | null {
        if (!row.metadata) return null;
        const entries = Object.entries(row.metadata).filter(([, v]) => v !== null && v !== undefined);
        if (entries.length === 0) return null;
        return entries.map(([k, v]) => `${k}: ${v}`).join(' · ');
    }

    private targetLabel(row: AuditRow): string | null {
        const entry = row.entry;
        if (!entry.targetId) return null;
        switch (entry.actionType) {
            case 'RoleCreated':
            case 'RoleUpdated':
            case 'RoleDeleted':
                return this.guild().roles.find(r => r.id === entry.targetId)?.name ?? null;
            case 'ChannelCreated':
            case 'ChannelUpdated':
            case 'ChannelDeleted':
            case 'ChannelPermissionChanged':
                return this.guild().channels.find(c => c.id === entry.targetId)?.name ?? null;
            case 'CategoryCreated':
            case 'CategoryDeleted':
                return this.guild().categories.find(c => c.id === entry.targetId)?.name ?? null;
            case 'MemberBanned':
            case 'MemberUnbanned':
            case 'MemberKicked':
            case 'MemberMuted':
            case 'MemberUnmuted':
                return row.targetProfile?.userName ?? null;
            default:
                return null;
        }
    }

    private fetchPage(): void {
        const skip = this.nextSkip;
        this.guildService.getAuditLog(this.guild().id, skip, this.TAKE).subscribe({
            next: entries => {
                const rows: AuditRow[] = entries.map(entry => ({
                    entry,
                    actorProfile: null,
                    targetProfile: null,
                    metadata: this.parseMetadata(entry.metadata),
                }));
                if (skip === 0) {
                    this.rows.set(rows);
                    this.loading.set(false);
                } else {
                    this.rows.update(list => [...list, ...rows]);
                    this.loadingMore.set(false);
                }
                this.nextSkip = skip + entries.length;
                if (entries.length < this.TAKE) this.hasMore.set(false);

                const baseIdx = skip === 0 ? 0 : this.rows().length - rows.length;
                rows.forEach((row, i) => {
                    this.profileService.fetchByUserId(row.entry.actorUserId).subscribe({
                        next: p => this.rows.update(list => {
                            const next = [...list];
                            const idx = baseIdx + i;
                            if (next[idx]) next[idx] = {...next[idx], actorProfile: p};
                            return next;
                        }),
                    });
                    if (row.entry.targetId && USER_TARGET_ACTIONS.has(row.entry.actionType)) {
                        this.profileService.fetchByUserId(row.entry.targetId).subscribe({
                            next: p => this.rows.update(list => {
                                const next = [...list];
                                const idx = baseIdx + i;
                                if (next[idx]) next[idx] = {...next[idx], targetProfile: p};
                                return next;
                            }),
                        });
                    }
                });
            },
            error: err => {
                this.loading.set(false);
                this.loadingMore.set(false);
                this.toastService.httpError('Failed to load audit log', err);
            },
        });
    }

    private parseMetadata(raw: string | null): Record<string, unknown> | null {
        if (!raw) return null;
        try {
            return JSON.parse(raw) as Record<string, unknown>;
        } catch {
            return null;
        }
    }
}
