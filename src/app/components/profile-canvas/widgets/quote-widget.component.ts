import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {ProfileDto} from '../../../dtos/response/profile.dto';
import {FONT_STACKS} from '../../../models/profile-font.model';
import {parseConfig} from '../../../models/profile-canvas';

interface QuoteConfig {
    text: string;
    attribution?: string;
}

function isQuoteConfig(value: unknown): value is QuoteConfig {
    return !!value && typeof value === 'object' && typeof (value as QuoteConfig).text === 'string';
}

@Component({
    selector: 'app-quote-widget',
    template: `
        @if (config(); as quote) {
            @if (quote.text) {
                <figure class="flex h-full flex-col justify-center gap-2 p-1">
                    <blockquote
                        [style.font-family]="fontStack()"
                        class="text-sm leading-snug text-text-primary"
                    >
                        {{ quote.text }}
                    </blockquote>
                    @if (quote.attribution) {
                        <figcaption class="text-xs text-text-muted">{{ quote.attribution }}</figcaption>
                    }
                </figure>
            }
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuoteWidgetComponent {
    readonly widget = input.required<CanvasWidgetDto>();
    readonly owner = input.required<ProfileDto>();

    protected readonly config = computed(() => parseConfig(this.widget().config, isQuoteConfig));

    protected readonly fontStack = computed(() => FONT_STACKS[this.owner().font]);
}
