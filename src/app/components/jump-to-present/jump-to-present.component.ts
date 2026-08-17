import {ChangeDetectionStrategy, Component, output} from '@angular/core';
import {TranslatePipe} from '@ngx-translate/core';

/** Floating pill shown while the message list is scrolled away from the newest message. */
@Component({
    selector: 'app-jump-to-present',
    imports: [TranslatePipe],
    changeDetection: ChangeDetectionStrategy.OnPush,
    styles: `
        @keyframes jump-to-present-in {
            from {
                opacity: 0;
                transform: translateY(0.75rem);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        .pill {
            animation: jump-to-present-in 160ms ease-out;
        }

        @media (prefers-reduced-motion: reduce) {
            .pill {
                animation: none;
            }
        }
    `,
    template: `
        <div
            class="pill flex items-center gap-2 rounded-full border border-border-subtle bg-card/95 py-1 pl-4 pr-1 shadow-lg backdrop-blur-sm select-none"
        >
            <span class="text-[0.8125rem] text-text-secondary">{{
                'MESSAGE.VIEWING_OLDER' | translate
            }}</span>
            <button
                type="button"
                (click)="jump.emit()"
                class="rounded-full bg-brand px-3 py-1 text-[0.8125rem] font-semibold text-white transition-colors hover:bg-brand-hover cursor-pointer"
            >
                {{ 'MESSAGE.JUMP_TO_PRESENT' | translate }}
            </button>
        </div>
    `,
})
export class JumpToPresentComponent {
    public jump = output();
}
