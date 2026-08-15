import {Component, computed, inject, input, OnInit, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {Checkbox} from 'primeng/checkbox';
import {InputText} from 'primeng/inputtext';
import {Select} from 'primeng/select';
import {Tooltip} from 'primeng/tooltip';
import {Dialog} from 'primeng/dialog';
import {PrimeTemplate} from 'primeng/api';
import {ChannelType, GuildDto} from '../../../../../../dtos/response/guild.dto';
import {GuildService} from '../../../../../../services/guild.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {ToastService} from '../../../../../../services/toast.service';
import {ApiConfigService} from '../../../../../../services/api-config.service';
import {MinuteClockService} from '../../../../../../services/minute-clock.service';
import {RelativeTimePipe} from '../../../../../../pipes/relative-time.pipe';
import {
    InviteDto,
    InviteTargetType,
    InviteType,
    isInviteExpired,
    isInviteRevoked,
    isInviteUsable,
} from "../../../../../../dtos/response/invite.dto";
import {TranslateModule, TranslateService} from '@ngx-translate/core';

export type ExpiryPresetId = '30m' | '1h' | '6h' | '12h' | '1d' | '7d' | 'never' | 'custom';

/**
 * The lifetimes worth one click. `null` hours means "never expires"; `custom` reads the hours
 * box instead, which is the only reason that box still exists.
 */
const EXPIRY_PRESETS: {id: ExpiryPresetId; hours: number | null; labelKey: string}[] = [
    {id: '30m', hours: 0.5, labelKey: 'GUILD_SETTINGS.INVITES.EXPIRY_PRESET_30_MINUTES'},
    {id: '1h', hours: 1, labelKey: 'GUILD_SETTINGS.INVITES.EXPIRY_PRESET_1_HOUR'},
    {id: '6h', hours: 6, labelKey: 'GUILD_SETTINGS.INVITES.EXPIRY_PRESET_6_HOURS'},
    {id: '12h', hours: 12, labelKey: 'GUILD_SETTINGS.INVITES.EXPIRY_PRESET_12_HOURS'},
    {id: '1d', hours: 24, labelKey: 'GUILD_SETTINGS.INVITES.EXPIRY_PRESET_1_DAY'},
    {id: '7d', hours: 168, labelKey: 'GUILD_SETTINGS.INVITES.EXPIRY_PRESET_7_DAYS'},
    {id: 'never', hours: null, labelKey: 'GUILD_SETTINGS.INVITES.EXPIRY_PRESET_NEVER'},
    {id: 'custom', hours: null, labelKey: 'GUILD_SETTINGS.INVITES.EXPIRY_PRESET_CUSTOM'},
];

/**
 * The use limits worth one click, matching the set Discord offers. `null` is unlimited.
 *
 * <p><b>There is no zero.</b> The server refuses `maxUses: 0` with a `400`, because an invite that
 * is exhausted the moment it exists is a link somebody is about to share - so it is not offered.</p>
 */
export const MAX_USES_PRESETS: readonly (number | null)[] = [null, 1, 5, 10, 25, 50, 100];

/**
 * Where invite links point, derived from the API host the account is actually on.
 *
 * <p>`https://api.venta.gg` -> `https://venta.gg`. Only a leading `api.` label is dropped: a
 * self-hosted `https://chat.example.com`, a bare name or an IP is already the site host and is
 * handed back untouched. This used to be a hardcoded `https://venta.gg`, which meant a dev or
 * self-hosted build copied production links that would never resolve to that instance.</p>
 */
export function inviteOrigin(apiUrl: string): string {
    let parsed: URL;
    try {
        parsed = new URL(apiUrl);
    } catch {
        return apiUrl;
    }

    const labels = parsed.hostname.split('.');
    const host = labels.length > 2 && labels[0] === 'api' ? labels.slice(1).join('.') : parsed.hostname;
    return `${parsed.protocol}//${host}${parsed.port ? `:${parsed.port}` : ''}`;
}

/**
 * The guild's join links.
 *
 * <p><b>This page is `ManageGuild` territory.</b> The list is the guild's entire set of live join
 * credentials, which is why the server moved its gate off `ManageChannel`. Nothing extra is done
 * here for it: `GuildSettingsModalComponent` refuses to render any page at all without
 * `ManageGuild`, so anyone standing here already holds it - which also settles the revoke button,
 * whose second, narrower route (`ManageChannel` on the invite's own channel) can only ever widen
 * the set of people this screen has already admitted.</p>
 *
 * <p><b>`state` is the server's answer and is never re-derived here.</b> There used to be a local
 * `expiresAt < now` check alongside it, from when nothing wrote `Expired` on the way past the
 * clock. The server computes it on every read now, including the one-time-invite case that has no
 * `maxUses` to compare against and that only it can see, so a second opinion here could only
 * disagree with the truth. The `expiresAt` timestamp is still read - for the countdown, which is a
 * different question from the badge.</p>
 */
@Component({
    selector: 'app-invites-settings',
    imports: [NgClass, Button, Checkbox, InputText, Select, Tooltip, Dialog, PrimeTemplate, TranslateModule, RelativeTimePipe, FormsModule],
    templateUrl: './invites-settings.component.html',
})
export class InvitesSettingsComponent implements OnInit {
    guild = input.required<GuildDto>();
    invites = signal<InviteDto[]>([]);
    loading = signal(true);
    /** Tracked per type so pressing one button doesn't spin the other. */
    creatingType = signal<InviteType | null>(null);
    deletingId = signal<string | null>(null);
    copiedId = signal<string | null>(null);
    /** The invite created a moment ago, so its row is findable without hunting for it. */
    highlightId = signal<string | null>(null);
    /** Effective lifetime in hours. `null` is "never expires"; anything <= 0 is rejected. */
    createExpiryHours = signal<number | null>(null);
    expiryPreset = signal<ExpiryPresetId>('never');
    /** `null` is unlimited. Never 0 - see {@link MAX_USES_PRESETS}. */
    createMaxUses = signal<number | null>(null);
    /** The channel a joiner lands on. Empty means "wherever the guild sends them". */
    createChannelId = signal<string | null>(null);
    createTemporary = signal(false);
    /** `VoiceChannel` drops the joiner into `createChannelId`, which then has to be a voice channel. */
    createTargetType = signal<InviteTargetType>(InviteTargetType.None);
    hideExpired = signal(false);
    /**
     * The audit view. Revoked invites are excluded by default, which is what keeps the ordinary
     * list the same shape it was before revocation existed.
     */
    showRevoked = signal(false);
    confirmRevokeInvite = signal<InviteDto | null>(null);
    showRevokeDialog = signal(false);
    /**
     * Ticks so "expires in 3 hours" doesn't sit frozen at whatever it read when the page opened.
     * The countdown only - the badge reads `state`.
     */
    clock = inject(MinuteClockService);
    /**
     * A getter, not `protected InviteType = InviteType`. A field whose initialiser is a bare
     * imported identifier is snapshotted by Vite's SSR transform: it hoists
     * `const InviteType = <import>` above the class instead of rewriting the reference in place.
     * Once the test bundle is code-split, the DTO lands in its own lazily initialised chunk and
     * that snapshot is taken before the chunk has run, so the field reads `undefined` and every
     * template binding through it throws. Reading inside a function body defers it.
     */
    protected get InviteType() {
        return InviteType;
    }

    protected get InviteTargetType() {
        return InviteTargetType;
    }

    protected expiryPresetOptions = computed(() =>
        EXPIRY_PRESETS.map(p => ({value: p.id, label: this.translate.instant(p.labelKey)})));
    protected maxUsesOptions = computed(() => MAX_USES_PRESETS.map(value => ({
        value,
        label: value === null
            ? this.translate.instant('GUILD_SETTINGS.INVITES.MAX_USES_UNLIMITED')
            : this.translate.instant('GUILD_SETTINGS.INVITES.MAX_USES_N', {count: value}),
    })));
    /** Only channels a joiner can be landed on. A list or a chore board is not somewhere to arrive. */
    protected channelOptions = computed(() => [
        {value: null, label: this.translate.instant('GUILD_SETTINGS.INVITES.CHANNEL_NONE')},
        ...this.guild().channels
            .filter(c => c.type === ChannelType.Text || c.type === ChannelType.Voice
                || c.type === ChannelType.Announcement)
            .map(c => ({value: c.id, label: `#${c.name}`})),
    ]);
    /**
     * `0` used to fall through to "never expires", quietly minting a permanent link for someone
     * who typed the smallest number they could. It is refused now, with the reason next to the
     * field rather than a silent substitution.
     */
    expiryError = computed<string | null>(() => {
        const hours = this.createExpiryHours();
        if (hours === null) return null;
        return Number.isFinite(hours) && hours > 0 ? null : 'GUILD_SETTINGS.INVITES.EXPIRY_INVALID';
    });
    /**
     * The one create-time rule the server also enforces, mirrored so the form says so before the
     * round trip rather than after it.
     */
    targetError = computed<string | null>(() => {
        if (this.createTargetType() !== InviteTargetType.VoiceChannel) return null;
        const channelId = this.createChannelId();
        const channel = this.guild().channels.find(c => c.id === channelId);
        if (!channel) return 'GUILD_SETTINGS.INVITES.TARGET_NEEDS_CHANNEL';
        return channel.type === ChannelType.Voice ? null : 'GUILD_SETTINGS.INVITES.TARGET_NEEDS_VOICE';
    });
    createError = computed<string | null>(() => this.expiryError() ?? this.targetError());
    expiredCount = computed(() => this.invites().filter(i => this.isExpired(i)).length);
    visibleInvites = computed(() =>
        this.hideExpired() ? this.invites().filter(i => !this.isExpired(i)) : this.invites());
    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);
    // Not `environment.apiUrl`: that constant is the venta.gg address baked in at build time, so
    // a self-hosted instance would hand out links pointing at our servers. This is the server the
    // active account is really on.
    private apiConfig = inject(ApiConfigService);

    constructor() {
        this.clock.retain();
    }

    ngOnInit(): void {
        this.load();
    }

    load(): void {
        this.loading.set(true);
        this.guildService.getInvites(this.guild().id, this.showRevoked()).subscribe({
            next: list => {
                this.invites.set(list);
                this.loading.set(false);
                // Guild does not own usernames, so the inviter arrives as a bare user id and is
                // hydrated through the same cache message authors use.
                for (const invite of list) {
                    if (invite.inviterId) this.profileService.resolveByUserId(invite.inviterId);
                }
            },
            error: err => {
                this.loading.set(false);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.INVITES.LOAD_ERROR'), err);
            },
        });
    }

    toggleRevokedView(): void {
        this.showRevoked.update(v => !v);
        this.load();
    }

    createPermanentInvite(): void {
        this.createInvite(InviteType.Permanent);
    }

    createOneTimeInvite(): void {
        this.createInvite(InviteType.OneTime);
    }

    selectExpiryPreset(id: ExpiryPresetId): void {
        this.expiryPreset.set(id);
        if (id === 'custom') return;
        this.createExpiryHours.set(EXPIRY_PRESETS.find(p => p.id === id)?.hours ?? null);
    }

    openRevokeDialog(invite: InviteDto): void {
        this.confirmRevokeInvite.set(invite);
        this.showRevokeDialog.set(true);
    }

    closeRevokeDialog(): void {
        this.confirmRevokeInvite.set(null);
        this.showRevokeDialog.set(false);
    }

    /**
     * Revokes an invite.
     *
     * <p>The row survives - members who joined through it still point at it - so the response is
     * the invite in its `Revoked` state rather than nothing. In the audit view it replaces the row
     * in place; in the ordinary view it leaves, because a revoked invite is not part of that list.</p>
     */
    revokeInvite(invite: InviteDto): void {
        if (this.deletingId()) return;
        this.deletingId.set(invite.id);
        this.guildService.deleteInvite(invite.id).subscribe({
            next: revoked => {
                this.invites.update(list => this.showRevoked()
                    ? list.map(i => i.id === invite.id ? (revoked ?? {...i, state: 'Revoked'}) : i)
                    : list.filter(i => i.id !== invite.id));
                this.deletingId.set(null);
                this.closeRevokeDialog();
            },
            error: err => {
                this.deletingId.set(null);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.INVITES.REVOKE_ERROR'), err);
            },
        });
    }

    copyInvite(invite: InviteDto): void {
        if (!isInviteUsable(invite)) return;
        this.writeLink(invite).then(
            () => this.markCopied(invite),
            // Clipboard writes are refused in insecure contexts and when permission is
            // denied; without this the button just sat there looking broken.
            () => this.toastService.error(this.translate.instant('GUILD_SETTINGS.INVITES.COPY_ERROR')),
        );
    }

    inviteLink(invite: InviteDto): string {
        return `${inviteOrigin(this.apiConfig.baseUrl())}/invite/${invite.code}`;
    }

    /** The server's answer, verbatim. Ran out on its own. */
    isExpired(invite: InviteDto): boolean {
        return isInviteExpired(invite);
    }

    /** Also the server's answer. Somebody took it away, which is a different thing from expiry. */
    isRevoked(invite: InviteDto): boolean {
        return isInviteRevoked(invite);
    }

    /** The inviter's display name, or empty while the profile is still resolving. */
    inviterName(invite: InviteDto): string {
        if (!invite.inviterId) return '';
        return this.profileService.getCachedByUserId(invite.inviterId)?.userName ?? '';
    }

    channelName(channelId: string | null | undefined): string {
        if (!channelId) return '';
        return this.guild().channels.find(c => c.id === channelId)?.name ?? '';
    }

    copyTooltipKey(invite: InviteDto): string {
        if (this.isRevoked(invite)) return 'GUILD_SETTINGS.INVITES.COPY_REVOKED';
        if (this.isExpired(invite)) return 'GUILD_SETTINGS.INVITES.COPY_EXPIRED';
        return this.copiedId() === invite.id ? 'GUILD.COPIED' : 'GUILD_SETTINGS.INVITES.COPY_LINK';
    }

    /** One absolute format for every timestamp on a row, day precision. */
    formatDate(d: Date | string): string {
        return new Date(d).toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'});
    }

    /** The same moment with the time of day, for the hover title where "in 3 hours" isn't enough. */
    formatDateTime(d: Date | string): string {
        return new Date(d).toLocaleString(undefined, {
            month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
        });
    }

    private createInvite(type: InviteType): void {
        if (this.creatingType() || this.createError()) return;
        this.creatingType.set(type);
        const hours = this.createExpiryHours();
        const expiresAt = hours !== null
            ? new Date(Date.now() + hours * 3600_000).toISOString()
            : undefined;
        const targetType = this.createTargetType();
        this.guildService.createInvite({
            type,
            expiresAt,
            // Omitted rather than sent as null: `{}` is exactly today's behaviour, and 0 is refused.
            maxUses: this.createMaxUses() ?? undefined,
            channelId: this.createChannelId() ?? undefined,
            temporary: this.createTemporary() || undefined,
            targetType: targetType === InviteTargetType.None ? undefined : targetType,
        }, this.guild().id).subscribe({
            next: invite => {
                this.invites.update(list => [invite, ...list]);
                this.creatingType.set(null);
                this.flagAsNew(invite);
                // The point of the button is to get a link to send someone, so hand it over
                // rather than making them find the new row and press Copy.
                this.writeLink(invite).then(
                    () => {
                        this.markCopied(invite);
                        this.toastService.success(this.translate.instant('GUILD_SETTINGS.INVITES.CREATED_COPIED'));
                    },
                    () => this.toastService.error(this.translate.instant('GUILD_SETTINGS.INVITES.CREATED_COPY_ERROR')),
                );
            },
            error: err => {
                this.creatingType.set(null);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.INVITES.CREATE_ERROR'), err);
            },
        });
    }

    private writeLink(invite: InviteDto): Promise<void> {
        // `navigator.clipboard` is absent entirely in insecure contexts, where reading
        // `.writeText` off undefined would throw straight out of the create handler.
        if (!navigator.clipboard?.writeText) return Promise.reject(new Error('clipboard unavailable'));
        return navigator.clipboard.writeText(this.inviteLink(invite));
    }

    private markCopied(invite: InviteDto): void {
        this.copiedId.set(invite.id);
        setTimeout(() => {
            if (this.copiedId() === invite.id) this.copiedId.set(null);
        }, 2000);
    }

    private flagAsNew(invite: InviteDto): void {
        this.highlightId.set(invite.id);
        setTimeout(() => {
            if (this.highlightId() === invite.id) this.highlightId.set(null);
        }, 5000);
    }
}
