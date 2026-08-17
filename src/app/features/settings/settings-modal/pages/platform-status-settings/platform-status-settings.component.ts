import {Component, computed, inject} from '@angular/core';
import {Button} from 'primeng/button';
import {TranslateModule} from '@ngx-translate/core';
import {PlatformStatusService} from '../../../../../services/platform-status.service';
import {ExternalLinkService} from '../../../../../services/external-link.service';
import {ApiConfigService} from '../../../../../services/api-config.service';
import {ComponentStatus, StatusComponentDto} from '../../../../../dtos/response/status.dto';
import {statusUrl} from '../../../../../core/support-url';

/** Anything not in here is a state this build has never heard of, and renders neutral. */
const STATUS_COLOURS: Record<string, string> = {
    operational: 'var(--color-online)',
    degraded_performance: 'var(--color-connecting)',
    partial_outage: 'var(--color-connecting)',
    major_outage: 'var(--color-offline)',
    under_maintenance: 'var(--color-brand-dim)',
};

const STATUS_LABELS: Record<string, string> = {
    operational: 'STATUS.COMPONENT.OPERATIONAL',
    degraded_performance: 'STATUS.COMPONENT.DEGRADED',
    partial_outage: 'STATUS.COMPONENT.PARTIAL_OUTAGE',
    major_outage: 'STATUS.COMPONENT.MAJOR_OUTAGE',
    under_maintenance: 'STATUS.COMPONENT.MAINTENANCE',
};

/** Platform status, as a destination rather than as part of the main UI. */
@Component({
    selector: 'app-platform-status-settings',
    imports: [Button, TranslateModule],
    templateUrl: './platform-status-settings.component.html',
})
export class PlatformStatusSettingsComponent {
    protected readonly status = inject(PlatformStatusService);
    private readonly links = inject(ExternalLinkService);
    private readonly apiConfig = inject(ApiConfigService);

    protected readonly components = this.status.components;
    protected readonly banner = this.status.banner;
    protected readonly unverified = this.status.unverified;

    /** True only once we have an answer and it is "everything is fine". */
    protected readonly allClear = computed(() =>
        this.status.summary() !== null && this.status.banner() === null);

    /**
     * The status site for whichever server this account is on, derived the same way the support
     * link is - a self-hosted account is sent to its own instance, not to ours.
     */
    protected readonly siteUrl = computed(() => statusUrl(this.apiConfig.baseUrl()));

    protected refresh(): void {
        this.status.probe();
    }

    protected openSite(): void {
        void this.links.openExternalLink(this.siteUrl());
    }

    protected colour(status: ComponentStatus): string {
        return STATUS_COLOURS[status] ?? 'rgba(255,255,255,0.30)';
    }

    /** A translation key, or null when the server sent a state this build does not know. */
    protected labelKey(status: ComponentStatus): string | null {
        return STATUS_LABELS[status] ?? null;
    }

    /** `0.9987` → `99.87 %`. Absent rather than `0 %` when the server did not send a number. */
    protected uptime(component: StatusComponentDto): string | null {
        if (typeof component.uptime90d !== 'number') return null;
        return `${(component.uptime90d * 100).toFixed(2)}%`;
    }
}
