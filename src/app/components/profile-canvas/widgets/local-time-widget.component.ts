import {ChangeDetectionStrategy, Component, computed, input, signal} from '@angular/core';
import {DestroyRef, inject} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {ProfileDto} from '../../../dtos/response/profile.dto';
import {parseConfig} from '../../../models/profile-canvas';

interface LocalTimeConfig {
    timeZone: string;
}

function isLocalTimeConfig(value: unknown): value is LocalTimeConfig {
    return !!value && typeof value === 'object' && typeof (value as LocalTimeConfig).timeZone === 'string';
}

@Component({
    selector: 'app-local-time-widget',
    imports: [TranslateModule],
    template: `
        @if (time(); as shown) {
            <div class="flex h-full flex-col items-center justify-center">
                <span class="text-xl font-bold tabular-nums text-text-primary">{{ shown }}</span>
                <span class="text-xs text-text-muted">{{
                    'PROFILE.CANVAS.LOCAL_TIME_LABEL' | translate
                }}</span>
            </div>
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LocalTimeWidgetComponent {
    readonly widget = input.required<CanvasWidgetDto>();
    readonly owner = input.required<ProfileDto>();

    private readonly now = signal(Date.now());

    protected readonly time = computed(() => {
        const config = parseConfig(this.widget().config, isLocalTimeConfig);
        if (!config) return null;
        try {
            return new Intl.DateTimeFormat(undefined, {
                hour: '2-digit',
                minute: '2-digit',
                timeZone: config.timeZone,
            }).format(this.now());
        } catch {
            // Intl throws on an unknown zone, and a canvas must never take the page down.
            return null;
        }
    });

    constructor() {
        const timer = setInterval(() => this.now.set(Date.now()), 30_000);
        inject(DestroyRef).onDestroy(() => clearInterval(timer));
    }
}
