import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {ProfileDto} from '../../../dtos/response/profile.dto';
import {parseConfig} from '../../../models/profile-canvas';

interface MarqueeConfig {
    text: string;
}

function isMarqueeConfig(value: unknown): value is MarqueeConfig {
    return !!value && typeof value === 'object' && typeof (value as MarqueeConfig).text === 'string';
}

@Component({
    selector: 'app-marquee-widget',
    template: `
        @if (config()?.text; as text) {
            <div class="flex h-full items-center overflow-hidden">
                <span class="marquee-track whitespace-nowrap text-sm text-brand-dim">{{ text }}</span>
            </div>
        }
    `,
    styles: `
        .marquee-track {
            padding-left: 100%;
            animation: canvas-marquee 15s linear infinite;
        }

        @keyframes canvas-marquee {
            to {
                transform: translateX(-100%);
            }
        }

        @media (prefers-reduced-motion: reduce) {
            .marquee-track {
                padding-left: 0;
                animation: none;
            }
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MarqueeWidgetComponent {
    readonly widget = input.required<CanvasWidgetDto>();
    readonly owner = input.required<ProfileDto>();

    protected readonly config = computed(() => parseConfig(this.widget().config, isMarqueeConfig));
}
