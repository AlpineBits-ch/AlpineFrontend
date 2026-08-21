import {ChangeDetectionStrategy, Component, computed, inject} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {PlatformStatusService} from '../../services/platform-status.service';
import {ExternalLinkService} from '../../services/external-link.service';
import {StatusSeverity} from '../../dtos/response/status.dto';

interface SeverityStyle {
    dot: string;
    icon: string;
    tint: string;
}

/** Three looks. An unrecognised severity must fall back to `info`, the quietest one. */
const SEVERITY_STYLES: Record<'info' | 'warning' | 'critical', SeverityStyle> = {
    info: {
        dot: 'var(--color-brand-dim)',
        icon: 'pi pi-info-circle',
        tint: 'color-mix(in srgb, var(--color-brand) 10%, transparent)',
    },
    warning: {
        dot: 'var(--color-connecting)',
        icon: 'pi pi-exclamation-triangle',
        tint: 'color-mix(in srgb, var(--color-connecting) 10%, transparent)',
    },
    critical: {
        dot: 'var(--color-offline)',
        icon: 'pi pi-exclamation-circle',
        tint: 'color-mix(in srgb, var(--color-offline) 12%, transparent)',
    },
};

/** The top-of-app platform status bar. `title` and `body` are the server's copy, rendered verbatim and untranslated. */
@Component({
    selector: 'app-status-banner',
    imports: [TranslateModule],
    templateUrl: './status-banner.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StatusBannerComponent {
    protected readonly status = inject(PlatformStatusService);
    private readonly links = inject(ExternalLinkService);

    protected readonly kind = this.status.bar;
    protected readonly banner = this.status.banner;

    protected readonly style = computed<SeverityStyle>(() => {
        // The "could not verify" bar is always the quietest one.
        if (this.kind() === 'unverified') return SEVERITY_STYLES.info;
        return styleFor(this.banner()?.severity);
    });

    protected open(): void {
        const url = this.banner()?.url;
        if (url) void this.links.openExternalLink(url);
    }

    protected dismiss(event: Event): void {
        event.stopPropagation();
        this.status.dismiss();
    }
}

function styleFor(severity: StatusSeverity | undefined): SeverityStyle {
    // Spelled out rather than indexed: `StatusIndicator` is an open union, so it is not a key of the closed record.
    if (severity === 'warning') return SEVERITY_STYLES.warning;
    if (severity === 'critical') return SEVERITY_STYLES.critical;
    return SEVERITY_STYLES.info;
}
