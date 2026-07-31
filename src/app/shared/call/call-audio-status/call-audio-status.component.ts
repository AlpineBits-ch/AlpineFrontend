import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {AudioState} from '../audio-wait';

/**
 * The per-participant audio indicator.
 *
 * Two states, deliberately far apart in tone: waiting for a subscribe to land is a loading state
 * and gets a quiet grey pill, while a participant still silent after the grace window gets the
 * amber warning. `ok` renders nothing.
 */
@Component({
    selector: 'app-call-audio-status',
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        @switch (state()) {
            @case ('connecting') {
                <span [class]="shellClass()" title="Waiting for audio from this participant">
                    Connecting
                    <span class="connecting-dots"><i></i><i></i><i></i></span>
                </span>
            }
            @case ('stalled') {
                <span [class]="shellClass()" title="No audio received from this participant">
                    <svg fill="currentColor" height="8" viewBox="0 0 24 24" width="8">
                        <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
                    </svg>
                    No audio
                </span>
            }
        }
    `,
    styles: `
        :host {
            display: inline-flex;
        }

        .connecting-dots {
            display: inline-flex;
            align-items: center;
            gap: 2px;
        }

        .connecting-dots i {
            width: 3px;
            height: 3px;
            border-radius: 9999px;
            background: currentColor;
            animation: call-connecting-dot 1.4s ease-in-out infinite;
        }

        .connecting-dots i:nth-child(2) {
            animation-delay: 0.18s;
        }

        .connecting-dots i:nth-child(3) {
            animation-delay: 0.36s;
        }

        @keyframes call-connecting-dot {
            0%, 70%, 100% {
                opacity: 0.3;
                transform: translateY(0);
            }
            35% {
                opacity: 1;
                transform: translateY(-1.5px);
            }
        }

        @media (prefers-reduced-motion: reduce) {
            .connecting-dots i {
                animation: none;
                opacity: 0.55;
            }
        }
    `,
})
export class CallAudioStatusComponent {
    state = input.required<AudioState>();
    /** `badge` is the standalone pill on a tile; `inline` sits in a text column under a name. */
    variant = input<'badge' | 'inline'>('badge');

    protected readonly shellClass = computed(() => {
        const badge = this.variant() === 'badge';
        const base = 'inline-flex items-center gap-1 text-[9px] font-medium leading-none'
            + (badge ? ' px-1.5 py-0.5 rounded-full border' : '');
        if (this.state() === 'stalled') {
            return base + (badge
                ? ' bg-amber-400/[0.15] border-amber-400/35 text-amber-400 font-semibold'
                : ' text-amber-400 font-semibold');
        }
        return base + (badge
            ? ' bg-white/[0.06] border-white/[0.10] text-white/45'
            : ' text-white/40');
    });
}
