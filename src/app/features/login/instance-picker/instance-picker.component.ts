import {ChangeDetectionStrategy, Component, computed, input, model, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {TranslateModule} from '@ngx-translate/core';
import {Select} from 'primeng/select';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {ApiConfigService} from '../../../services/api-config.service';

/** How many signed-in instances are offered under the home one. */
const RECENT_LIMIT = 3;

export interface InstanceOption {
    label: string;
    value: string;
}

/**
 * Which instance the login card is talking to.
 *
 * <p>Owns no network: the host probes the chosen domain and hands back {@link state}, which is what
 * lets this spec run without an HTTP harness.</p>
 */
@Component({
    selector: 'app-instance-picker',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [FormsModule, TranslateModule, Select, Button, InputText],
    templateUrl: './instance-picker.component.html',
})
export class InstancePickerComponent {
    readonly domain = model.required<string>();

    /** Instances this machine has signed in to, most recent first. */
    readonly recents = input<readonly string[]>([]);
    readonly state = input<'idle' | 'loading' | 'error'>('idle');

    protected readonly adding = signal(false);
    protected draft = '';

    // A getter, not a field: a class field initialised from an imported binding reads undefined in
    // full-suite runs under Vite.
    protected get home(): string {
        return ApiConfigService.homeDomain;
    }

    /**
     * Home first, then the signed-in instances that are not it, then whatever is selected.
     *
     * <p>The selected domain is always present: a `p-select` whose value is absent from its
     * options renders blank.</p>
     */
    protected readonly options = computed<InstanceOption[]>(() => {
        const home = ApiConfigService.homeDomain;
        const rest = this.recents().filter(d => d !== home);
        const domains = [home, ...rest.slice(0, RECENT_LIMIT)];
        if (!domains.includes(this.domain())) domains.push(this.domain());
        return domains.map(value => ({label: value, value}));
    });

    protected choose(domain: string): void {
        this.domain.set(domain);
    }

    /** Closes the panel the action was taken from, so the input is not hidden behind it. */
    protected startAdd(select: {hide: () => void}): void {
        select.hide();
        this.draft = '';
        this.adding.set(true);
    }

    protected cancelAdd(): void {
        this.adding.set(false);
    }

    protected confirmAdd(): void {
        const domain = normalizeDomain(this.draft);
        if (!domain) return;
        this.adding.set(false);
        this.domain.set(domain);
    }
}

/** Accepts what people paste: a full URL, a trailing slash, stray spaces. */
export function normalizeDomain(raw: string): string {
    return raw
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/\/+$/, '');
}
