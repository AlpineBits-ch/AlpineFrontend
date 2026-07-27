import {Component, inject, input, OnInit, signal} from '@angular/core';
import {DatePipe} from '@angular/common';
import {GuildDto} from '../../../../../../dtos/response/guild.dto';
import {AuditLogEntryDto} from '../../../../../../dtos/response/audit-log-entry.dto';
import {ProfileDto} from '../../../../../../dtos/response/profile.dto';
import {GuildService} from '../../../../../../services/guild.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {ToastService} from '../../../../../../services/toast.service';
import {Button} from 'primeng/button';

interface AuditRow {
    entry: AuditLogEntryDto;
    actorProfile: ProfileDto | null;
    metadata: Record<string, unknown> | null;
}

@Component({
    selector: 'app-audit-log-settings',
    imports: [Button, DatePipe],
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

    describe(entry: AuditLogEntryDto): string {
        const map: Record<string, string> = {
            MemberBanned: 'banned a member', MemberUnbanned: 'unbanned a member',
            MemberKicked: 'kicked a member', MemberMuted: 'timed out a member',
            MemberUnmuted: 'removed a timeout', MemberLeft: 'left the server',
            RoleCreated: 'created a role', RoleUpdated: 'updated a role', RoleDeleted: 'deleted a role',
            RolePositionsChanged: 'reordered roles',
            ChannelCreated: 'created a channel', ChannelDeleted: 'deleted a channel',
            ChannelUpdated: 'updated a channel', ChannelPermissionChanged: 'changed channel permissions',
            CategoryCreated: 'created a category', CategoryDeleted: 'deleted a category',
            GuildUpdated: 'updated server settings', GuildDeleted: 'deleted the server',
            InviteCreated: 'created an invite', InviteDeleted: 'deleted an invite',
        };
        return map[entry.actionType] ?? entry.actionType;
    }

    private fetchPage(): void {
        const skip = this.nextSkip;
        this.guildService.getAuditLog(this.guild().id, skip, this.TAKE).subscribe({
            next: entries => {
                const rows: AuditRow[] = entries.map(entry => ({
                    entry,
                    actorProfile: null,
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
