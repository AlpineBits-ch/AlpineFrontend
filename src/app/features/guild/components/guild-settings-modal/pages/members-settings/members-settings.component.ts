import {Component, inject, input, OnInit, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Dialog} from 'primeng/dialog';
import {Tooltip} from 'primeng/tooltip';
import {GuildDto} from '../../../../../../dtos/response/guild.dto';
import {GuildMemberDto} from '../../../../../../dtos/response/member.dto';
import {GuildService} from '../../../../../../services/guild.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {ProfileDto} from '../../../../../../dtos/response/profile.dto';
import {parsePermissions, Permissions, stringifyPermissions} from '../../../../../../enums/permissions.enum';
import {PermissionToggleComponent} from '../../../../shared/permission-toggle/permission-toggle.component';
import {PrimeTemplate} from "primeng/api";
import {TranslateModule} from '@ngx-translate/core';

interface MemberRow {
    member: GuildMemberDto;
    profile: ProfileDto | null;
    roleNames: string[];
}

@Component({
    selector: 'app-members-settings',
    imports: [FormsModule, Button, InputText, Dialog, Tooltip, PermissionToggleComponent, PrimeTemplate, TranslateModule],
    templateUrl: './members-settings.component.html',
})
export class MembersSettingsComponent implements OnInit {
    guild = input.required<GuildDto>();
    members = signal<MemberRow[]>([]);
    loading = signal(true);
    loadingMore = signal(false);
    hasMore = signal(true);
    filter = signal('');
    editMember = signal<MemberRow | null>(null);
    showEditDialog = signal(false);
    editPermMask = signal(0n);
    editSaving = signal(false);
    confirmKickMember = signal<MemberRow | null>(null);
    showKickDialog = signal(false);
    kicking = signal(false);
    protected readonly Permissions = Permissions;
    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);
    private readonly TAKE = 50;
    private nextSkip = 0;

    get filteredMembers(): MemberRow[] {
        const q = this.filter().toLowerCase();
        if (!q) return this.members();
        return this.members().filter(row => {
            const name = row.profile?.userName ?? '';
            return name.toLowerCase().includes(q) || row.member.userId.includes(q);
        });
    }

    ngOnInit(): void {
        this.load();
    }

    load(): void {
        this.loading.set(true);
        this.nextSkip = 0;
        this.hasMore.set(true);
        this.members.set([]);
        this.fetchPage();
    }

    loadMore(): void {
        if (this.loadingMore() || !this.hasMore() || this.loading()) return;
        this.loadingMore.set(true);
        this.fetchPage();
    }

    onScroll(event: Event): void {
        const el = event.target as HTMLElement;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 150) {
            this.loadMore();
        }
    }

    openEditPermissions(row: MemberRow): void {
        this.editMember.set(row);
        this.editPermMask.set(parsePermissions(row.member.permissions));
        this.showEditDialog.set(true);
    }

    onPermissionChange(mask: bigint): void {
        this.editPermMask.set(mask);
    }

    savePermissions(): void {
        const row = this.editMember();
        if (!row || this.editSaving()) return;
        this.editSaving.set(true);
        const perm = stringifyPermissions(this.editPermMask());
        this.guildService.updateMemberPermissions(this.guild().id, row.member.id, perm).subscribe({
            next: updated => {
                this.members.update(list =>
                    list.map(r => r.member.id === updated.id
                        ? {...r, member: updated}
                        : r
                    )
                );
                this.editMember.set(null);
                this.showEditDialog.set(false);
                this.editSaving.set(false);
            },
            error: () => this.editSaving.set(false),
        });
    }

    kickMember(row: MemberRow): void {
        if (this.kicking()) return;
        this.kicking.set(true);
        this.guildService.kickMember(this.guild().id, row.member.id).subscribe({
            next: () => {
                this.members.update(list => list.filter(r => r.member.id !== row.member.id));
                this.confirmKickMember.set(null);
                this.kicking.set(false);
            },
            error: () => this.kicking.set(false),
        });
    }

    openKickDialog(row: MemberRow): void {
        this.confirmKickMember.set(row);
        this.showKickDialog.set(true);
    }

    closeKickDialog(): void {
        this.confirmKickMember.set(null);
        this.showKickDialog.set(false);
    }

    displayName(row: MemberRow): string {
        return row.profile?.userName ?? row.member.userId.slice(0, 8) + '…';
    }

    avatarUrl(row: MemberRow): string | undefined {
        return row.profile?.avatarUrl;
    }

    private fetchPage(): void {
        const skip = this.nextSkip;
        this.guildService.getMembers(this.guild().id, skip, this.TAKE).subscribe({
            next: incoming => {
                const baseIdx = skip === 0 ? 0 : this.members().length;
                const rows: MemberRow[] = incoming.map(m => ({
                    member: m,
                    profile: null,
                    roleNames: this.roleNamesFor(m),
                }));

                if (skip === 0) {
                    this.members.set(rows);
                    this.loading.set(false);
                } else {
                    this.members.update(list => [...list, ...rows]);
                    this.loadingMore.set(false);
                }

                this.nextSkip = skip + incoming.length;
                if (incoming.length < this.TAKE) this.hasMore.set(false);

                rows.forEach((row, i) => {
                    this.profileService.fetchByUserId(row.member.userId).subscribe({
                        next: p => {
                            this.members.update(list => {
                                const next = [...list];
                                const idx = baseIdx + i;
                                if (next[idx]) next[idx] = {...next[idx], profile: p};
                                return next;
                            });
                        },
                    });
                });
            },
            error: () => {
                this.loading.set(false);
                this.loadingMore.set(false);
            },
        });
    }

    private roleNamesFor(member: GuildMemberDto): string[] {
        return this.guild().roles
            .filter(r => r.userId === member.userId)
            .map(r => r.name);
    }
}
