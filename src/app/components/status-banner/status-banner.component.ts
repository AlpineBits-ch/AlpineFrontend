import {Component, computed, inject} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {PlatformStatusService} from '../../services/platform-status.service';
import {ExternalLinkService} from '../../services/external-link.service';
import {StatusSeverity} from '../../dtos/response/status.dto';

interface SeverityStyle {
    dot: string;
    icon: string;
    tint: string;
}

/**
 * Three looks, and `info` is the fallback for anything else.
 *
 * <p>An unrecognised severity must render as the quietest thing here. A build that guessed upward
 * would turn a future `notice` into a red bar across everyone's app.</p>
 */
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

/**
 * The top-of-app platform status bar.
 *
 * <p><b>The copy is the server's.</b> `title` and `body` are rendered verbatim, because the server
 * owns how technical a status message is allowed to be - "Some people may not be able to sign in",
 * never "identity 5xx rate 31 %". The `template` field exists to key a client-side translation off,
 * but taking it up means shipping our own display name and impact hint for every component key, and
 * a half-translated outage notice is worse than an English one. Staff-written incidents
 * (`template === null`) have no translation path at all and never will: a machine-translated
 * outage notice is a liability.</p>
 *
 * <p>Deliberately not a modal and deliberately not blocking. Degraded means <i>some</i> requests
 * fail, and retrying is often exactly the right move - so nothing here disables a feature, forces a
 * sign-out, or covers the app.</p>
 */
@Component({
    selector: 'app-status-banner',
    imports: [TranslateModule],
    templateUrl: './status-banner.component.html',
})
export class StatusBannerComponent {
    protected readonly status = inject(PlatformStatusService);
    private readonly links = inject(ExternalLinkService);

    protected readonly kind = this.status.bar;
    protected readonly banner = this.status.banner;

    protected readonly style = computed<SeverityStyle>(() => {
        // The "could not verify" bar is always the quietest one: not being able to check is not
        // itself evidence that anything is wrong.
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
    // Spelled out rather than indexed: `StatusIndicator` is an open union, so `string & {}`
    // survives the narrowing and TypeScript will not accept it as a key of the closed record.
    if (severity === 'warning') return SEVERITY_STYLES.warning;
    if (severity === 'critical') return SEVERITY_STYLES.critical;
    return SEVERITY_STYLES.info;
}
