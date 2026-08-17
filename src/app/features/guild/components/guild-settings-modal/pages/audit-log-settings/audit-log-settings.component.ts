import {Component, computed, inject, input, OnDestroy, OnInit, signal} from '@angular/core';
import {DatePipe} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Select} from 'primeng/select';
import {GuildDto} from '../../../../../../dtos/response/guild.dto';
import {AuditLogEntryDto} from '../../../../../../dtos/response/audit-log-entry.dto';
import {ProfileDto} from '../../../../../../dtos/response/profile.dto';
import {GuildService} from '../../../../../../services/guild.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {ToastService} from '../../../../../../services/toast.service';
import {RelativeTimePipe} from '../../../../../../pipes/relative-time.pipe';
import {TranslateModule, TranslateService} from '@ngx-translate/core';

interface MetadataPair {
    label: string;
    value: string;
}

interface AuditRow {
    entry: AuditLogEntryDto;
    metadata: Record<string, unknown> | null;
    /** Readable metadata, built once on arrival rather than on every change detection pass. */
    details: MetadataPair[];
}

/** One day's worth of entries. `label` is a translation key, or null when the date is spelled out. */
interface AuditDay {
    key: string;
    date: Date;
    label: string | null;
    rows: AuditRow[];
}

const USER_TARGET_ACTIONS = new Set([
    'MemberBanned',
    'MemberUnbanned',
    'MemberKicked',
    'MemberMuted',
    'MemberUnmuted',
]);

/** Action type to translation-key stem; actions with a `_GENERIC` counterpart fall back to it when the target can't be resolved (e.g. a deleted role has no name left to print). Also the source of the filter dropdown, so options never drift from what the page can describe. */
const ACTION_KEYS: Record<string, string> = {
    MemberBanned: 'MEMBER_BANNED',
    MemberUnbanned: 'MEMBER_UNBANNED',
    MemberKicked: 'MEMBER_KICKED',
    MemberMuted: 'MEMBER_MUTED',
    MemberUnmuted: 'MEMBER_UNMUTED',
    MemberLeft: 'MEMBER_LEFT',
    RoleCreated: 'ROLE_CREATED',
    RoleUpdated: 'ROLE_UPDATED',
    RoleDeleted: 'ROLE_DELETED',
    RolePositionsChanged: 'ROLE_POSITIONS_CHANGED',
    ChannelCreated: 'CHANNEL_CREATED',
    ChannelDeleted: 'CHANNEL_DELETED',
    ChannelUpdated: 'CHANNEL_UPDATED',
    ChannelPermissionChanged: 'CHANNEL_PERMISSION_CHANGED',
    CategoryCreated: 'CATEGORY_CREATED',
    CategoryDeleted: 'CATEGORY_DELETED',
    GuildUpdated: 'GUILD_UPDATED',
    GuildDeleted: 'GUILD_DELETED',
    InviteCreated: 'INVITE_CREATED',
    InviteDeleted: 'INVITE_DELETED',
};

/** Actions whose sentence never interpolates a target, so no `_GENERIC` variant exists. */
const TARGETLESS_ACTIONS = new Set([
    'MemberLeft',
    'RolePositionsChanged',
    'GuildUpdated',
    'GuildDeleted',
    'InviteCreated',
    'InviteDeleted',
]);

const ACTION_ICONS: Record<string, string> = {
    MemberBanned: 'pi-ban',
    MemberUnbanned: 'pi-check-circle',
    MemberKicked: 'pi-user-minus',
    MemberMuted: 'pi-volume-off',
    MemberUnmuted: 'pi-volume-up',
    MemberLeft: 'pi-sign-out',
    RoleCreated: 'pi-shield',
    RoleUpdated: 'pi-shield',
    RoleDeleted: 'pi-shield',
    RolePositionsChanged: 'pi-sort-alt',
    ChannelCreated: 'pi-hashtag',
    ChannelUpdated: 'pi-hashtag',
    ChannelDeleted: 'pi-hashtag',
    ChannelPermissionChanged: 'pi-lock',
    CategoryCreated: 'pi-folder',
    CategoryDeleted: 'pi-folder',
    GuildUpdated: 'pi-cog',
    GuildDeleted: 'pi-trash',
    InviteCreated: 'pi-link',
    InviteDeleted: 'pi-link',
};

/** Anything that takes something away, so it stands out from routine configuration noise. */
const DESTRUCTIVE_ACTIONS = new Set([
    'MemberBanned',
    'MemberKicked',
    'MemberMuted',
    'RoleDeleted',
    'ChannelDeleted',
    'CategoryDeleted',
    'GuildDeleted',
    'InviteDeleted',
]);

const ADDITIVE_ACTIONS = new Set([
    'MemberUnbanned',
    'MemberUnmuted',
    'RoleCreated',
    'ChannelCreated',
    'CategoryCreated',
    'InviteCreated',
]);

const EDIT_ACTIONS = new Set(['RoleUpdated', 'ChannelUpdated', 'ChannelPermissionChanged', 'GuildUpdated']);

/** Metadata fields the server may carry the target's name in, newest wording first; the only way an entry about a deleted role or channel can still name it, since `targetLabel` resolves live names and this one is gone. */
const NAME_METADATA_KEYS = ['name', 'targetName', 'roleName', 'channelName', 'categoryName', 'oldName'];

/** How often the relative timestamps are recomputed. */
const TICK_INTERVAL = 60_000;

@Component({
    selector: 'app-audit-log-settings',
    imports: [DatePipe, FormsModule, Button, InputText, Select, RelativeTimePipe, TranslateModule],
    templateUrl: './audit-log-settings.component.html',
})
export class AuditLogSettingsComponent implements OnInit, OnDestroy {
    readonly guild = input.required<GuildDto>();
    readonly rows = signal<AuditRow[]>([]);
    readonly loading = signal(true);
    readonly loadingMore = signal(false);
    readonly refreshing = signal(false);
    readonly hasMore = signal(true);
    readonly actionFilter = signal<string | null>(null);
    readonly actorFilter = signal('');
    /** Ticks so `relativeTime` (a pure pipe) doesn't freeze at the timestamps it first rendered. */
    readonly now = signal(Date.now());

    readonly actionOptions = computed(() =>
        Object.entries(ACTION_KEYS)
            .map(([type, stem]) => ({
                value: type,
                label: this.translate.instant(`GUILD_SETTINGS.AUDIT_LOG.TYPE.${stem}`) as string,
            }))
            .sort((a, b) => a.label.localeCompare(b.label)),
    );

    readonly filtersActive = computed(() => !!this.actionFilter() || this.actorFilter().trim().length > 0);

    /** The audit log endpoint only takes skip/take, so both filters run over pages already fetched, not the whole log; the template must say so rather than passing off a partial answer as complete. */
    readonly filteredRows = computed(() => {
        const action = this.actionFilter();
        const actor = this.actorFilter().trim().toLowerCase();
        if (!action && !actor) return this.rows();
        return this.rows().filter(row => {
            if (action && row.entry.actionType !== action) return false;
            return !actor || this.actorName(row).toLowerCase().includes(actor);
        });
    });

    readonly days = computed<AuditDay[]>(() => {
        const tick = this.now();
        const groups: AuditDay[] = [];
        for (const row of this.filteredRows()) {
            const date = new Date(row.entry.createdAt);
            const key = date.toDateString();
            const current = groups[groups.length - 1];
            if (current && current.key === key) current.rows.push(row);
            else groups.push({key, date, label: this.dayLabel(date, tick), rows: [row]});
        }
        return groups;
    });

    private readonly TAKE = 50;
    private nextSkip = 0;
    private readonly profiles = signal<Record<string, ProfileDto>>({});
    private readonly expanded = signal<ReadonlySet<string>>(new Set());
    /** Ids already asked for, so a second page of the same three moderators costs nothing. */
    private requestedProfileIds = new Set<string>();
    private ticker?: ReturnType<typeof setInterval>;
    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);

    ngOnInit(): void {
        this.load();
        this.ticker = setInterval(() => this.now.set(Date.now()), TICK_INTERVAL);
    }

    ngOnDestroy(): void {
        clearInterval(this.ticker);
    }

    load(): void {
        this.loading.set(true);
        this.rows.set([]);
        this.fetchPage('initial');
    }

    /** Keeps the current entries on screen while it re-reads page one, so the list doesn't blink. */
    refresh(): void {
        if (this.refreshing() || this.loading()) return;
        this.refreshing.set(true);
        this.fetchPage('refresh');
    }

    loadMore(): void {
        if (this.loadingMore() || !this.hasMore() || this.loading() || this.refreshing()) return;
        this.loadingMore.set(true);
        this.fetchPage('more');
    }

    onScroll(event: Event): void {
        const el = event.target as HTMLElement;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 150) this.loadMore();
    }

    clearFilters(): void {
        this.actionFilter.set(null);
        this.actorFilter.set('');
    }

    actorName(row: AuditRow): string {
        const profile = this.profiles()[row.entry.actorUserId];
        return profile?.userName ?? this.translate.instant('GUILD_SETTINGS.AUDIT_LOG.UNKNOWN_ACTOR');
    }

    describe(row: AuditRow): string {
        const stem = ACTION_KEYS[row.entry.actionType];
        // An unmapped action type still says something useful rather than rendering a blank.
        if (!stem) return row.entry.actionType;

        const base = `GUILD_SETTINGS.AUDIT_LOG.ACTION.${stem}`;
        if (TARGETLESS_ACTIONS.has(row.entry.actionType)) return this.translate.instant(base);

        const target = this.targetLabel(row);
        return target ? this.translate.instant(base, {target}) : this.translate.instant(`${base}_GENERIC`);
    }

    actionIcon(row: AuditRow): string {
        return ACTION_ICONS[row.entry.actionType] ?? 'pi-history';
    }

    actionTone(row: AuditRow): string {
        const type = row.entry.actionType;
        if (DESTRUCTIVE_ACTIONS.has(type)) return 'text-offline';
        if (ADDITIVE_ACTIONS.has(type)) return 'text-online';
        if (EDIT_ACTIONS.has(type)) return 'text-connecting';
        return 'text-brand-dim';
    }

    isExpanded(id: string): boolean {
        return this.expanded().has(id);
    }

    toggleDetails(id: string): void {
        this.expanded.update(open => {
            const next = new Set(open);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    private dayLabel(date: Date, tick: number): string | null {
        const today = new Date(tick);
        const days = Math.round((this.startOfDay(today) - this.startOfDay(date)) / 86_400_000);
        if (days === 0) return 'GUILD_SETTINGS.AUDIT_LOG.TODAY';
        if (days === 1) return 'GUILD_SETTINGS.AUDIT_LOG.YESTERDAY';
        return null;
    }

    private startOfDay(date: Date): number {
        return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    }

    private targetLabel(row: AuditRow): string | null {
        const entry = row.entry;
        if (!entry.targetId) return null;
        switch (entry.actionType) {
            case 'RoleCreated':
            case 'RoleUpdated':
            case 'RoleDeleted':
                return this.guild().roles.find(r => r.id === entry.targetId)?.name ?? this.metadataName(row);
            case 'ChannelCreated':
            case 'ChannelUpdated':
            case 'ChannelDeleted':
            case 'ChannelPermissionChanged':
                return (
                    this.guild().channels.find(c => c.id === entry.targetId)?.name ?? this.metadataName(row)
                );
            case 'CategoryCreated':
            case 'CategoryDeleted':
                return (
                    this.guild().categories.find(c => c.id === entry.targetId)?.name ?? this.metadataName(row)
                );
            case 'MemberBanned':
            case 'MemberUnbanned':
            case 'MemberKicked':
            case 'MemberMuted':
            case 'MemberUnmuted':
                return this.profiles()[entry.targetId]?.userName ?? this.metadataName(row);
            default:
                return null;
        }
    }

    /** The target's name as it was when the action happened, if the entry recorded one. */
    private metadataName(row: AuditRow): string | null {
        if (!row.metadata) return null;
        for (const key of NAME_METADATA_KEYS) {
            const value = row.metadata[key];
            if (typeof value === 'string' && value.trim()) return value.trim();
        }
        return null;
    }

    private fetchPage(mode: 'initial' | 'refresh' | 'more'): void {
        const skip = mode === 'more' ? this.nextSkip : 0;
        this.guildService.getAuditLog(this.guild().id, skip, this.TAKE).subscribe({
            next: entries => {
                const rows = entries.map(entry => this.toRow(entry));
                if (mode === 'more') this.rows.update(list => [...list, ...rows]);
                else this.rows.set(rows);
                this.nextSkip = skip + entries.length;
                this.hasMore.set(entries.length === this.TAKE);
                this.settle();
                this.resolveProfiles(rows);
            },
            error: err => {
                this.settle();
                this.toastService.httpError(
                    this.translate.instant('GUILD_SETTINGS.AUDIT_LOG.LOAD_ERROR'),
                    err,
                );
            },
        });
    }

    private settle(): void {
        this.loading.set(false);
        this.loadingMore.set(false);
        this.refreshing.set(false);
    }

    /** One request per distinct user id; `getByUserId` also answers from the profile cache when the person is already on screen elsewhere. */
    private resolveProfiles(rows: AuditRow[]): void {
        const ids = new Set<string>();
        for (const row of rows) {
            ids.add(row.entry.actorUserId);
            if (row.entry.targetId && USER_TARGET_ACTIONS.has(row.entry.actionType))
                ids.add(row.entry.targetId);
        }

        for (const id of ids) {
            if (this.requestedProfileIds.has(id)) continue;
            this.requestedProfileIds.add(id);
            this.profileService.getByUserId(id).subscribe({
                next: profile => {
                    // The service hands out a placeholder profile while its breaker is open; storing it would pin "Unknown User" for the session, so the id is forgotten instead to let a refresh retry.
                    if (profile.userId === 'unknown') {
                        this.requestedProfileIds.delete(id);
                        return;
                    }
                    this.profiles.update(map => ({...map, [id]: profile}));
                },
                error: () => this.requestedProfileIds.delete(id),
            });
        }
    }

    private toRow(entry: AuditLogEntryDto): AuditRow {
        const metadata = this.parseMetadata(entry.metadata);
        return {entry, metadata, details: this.toDetails(metadata)};
    }

    private toDetails(metadata: Record<string, unknown> | null): MetadataPair[] {
        if (!metadata) return [];
        return Object.entries(metadata)
            .filter(([, value]) => value !== null && value !== undefined && value !== '')
            .map(([key, value]) => ({label: this.humaniseKey(key), value: this.formatValue(value)}));
    }

    /** `oldName` to "Old name": these are server field names with no translation catalogue, so this reshapes them instead. */
    private humaniseKey(key: string): string {
        const words = key
            .replace(/[_-]+/g, ' ')
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .trim()
            .toLowerCase();
        return words.charAt(0).toUpperCase() + words.slice(1);
    }

    private formatValue(value: unknown): string {
        if (typeof value === 'boolean') {
            return this.translate.instant(
                value ? 'GUILD_SETTINGS.AUDIT_LOG.VALUE_YES' : 'GUILD_SETTINGS.AUDIT_LOG.VALUE_NO',
            );
        }
        if (Array.isArray(value)) return value.map(item => this.formatValue(item)).join(', ');
        if (typeof value === 'object') return JSON.stringify(value);
        return String(value);
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
