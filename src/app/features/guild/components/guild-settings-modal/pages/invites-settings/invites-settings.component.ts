import {Component, computed, inject, input, OnInit, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Select} from 'primeng/select';
import {Tooltip} from 'primeng/tooltip';
import {Dialog} from 'primeng/dialog';
import {PrimeTemplate} from 'primeng/api';
import {GuildDto} from '../../../../../../dtos/response/guild.dto';
import {GuildService} from '../../../../../../services/guild.service';
import {ToastService} from '../../../../../../services/toast.service';
import {ApiConfigService} from '../../../../../../services/api-config.service';
import {MinuteClockService} from '../../../../../../services/minute-clock.service';
import {RelativeTimePipe} from '../../../../../../pipes/relative-time.pipe';
import {InviteDto, InviteState, InviteType} from "../../../../../../dtos/response/invite.dto";
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

@Component({
    selector: 'app-invites-settings',
    imports: [NgClass, Button, InputText, Select, Tooltip, Dialog, PrimeTemplate, TranslateModule, RelativeTimePipe, FormsModule],
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
    hideExpired = signal(false);
    confirmRevokeInvite = signal<InviteDto | null>(null);
    showRevokeDialog = signal(false);
    /**
     * Ticks so "expires in 3 hours" doesn't sit frozen at whatever it read when the page opened,
     * and is server-corrected, so a machine with a wrong local clock still greys out the right rows.
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
    protected expiryPresetOptions = computed(() =>
        EXPIRY_PRESETS.map(p => ({value: p.id, label: this.translate.instant(p.labelKey)})));
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
    expiredCount = computed(() => this.invites().filter(i => this.isExpired(i)).length);
    visibleInvites = computed(() =>
        this.hideExpired() ? this.invites().filter(i => !this.isExpired(i)) : this.invites());
    private guildService = inject(GuildService);
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
        this.guildService.getInvites(this.guild().id).subscribe({
            next: list => {
                this.invites.set(list);
                this.loading.set(false);
            },
            error: err => {
                this.loading.set(false);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.INVITES.LOAD_ERROR'), err);
            },
        });
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

    revokeInvite(invite: InviteDto): void {
        if (this.deletingId()) return;
        this.deletingId.set(invite.id);
        this.guildService.deleteInvite(invite.id).subscribe({
            next: () => {
                this.invites.update(list => list.filter(i => i.id !== invite.id));
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
        if (this.isExpired(invite)) return;
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

    /**
     * The server's `state` is a snapshot from when the list was fetched, so a link can lapse while
     * the modal sits open. The timestamp is checked too, otherwise a stale row keeps a working
     * Copy button.
     */
    isExpired(invite: InviteDto): boolean {
        if (invite.state === InviteState.Expired) return true;
        return !!invite.expiresAt && new Date(invite.expiresAt).getTime() <= this.clock.now();
    }

    copyTooltipKey(invite: InviteDto): string {
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
        if (this.creatingType() || this.expiryError()) return;
        this.creatingType.set(type);
        const hours = this.createExpiryHours();
        const expiresAt = hours !== null
            ? new Date(Date.now() + hours * 3600_000).toISOString()
            : undefined;
        this.guildService.createInvite({type, expiresAt}, this.guild().id).subscribe({
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
