import {Component, effect, input, signal} from '@angular/core';

const STATE_KEY_PREFIX = 'wiki-rail-section:';

/** One collapsible block of the rail; collapse state is per section and persisted, since the sections a given person ignores tend to stay the same. */
@Component({
    selector: 'app-wiki-rail-section',
    imports: [],
    template: `
        <section class="mb-5">
            <button
                (click)="toggle()"
                [attr.aria-expanded]="open()"
                [title]="heading()"
                class="group flex w-full cursor-pointer items-center gap-1.5 border-0
                           bg-transparent px-0 py-1 text-left"
            >
                <i
                    [class.pi-angle-down]="open()"
                    [class.pi-angle-right]="!open()"
                    class="pi text-[0.625rem] text-text-muted group-hover:text-text-secondary"
                ></i>
                <h2
                    class="flex-1 truncate text-[0.625rem] font-semibold uppercase tracking-widest
                           text-text-muted group-hover:text-text-secondary"
                >
                    {{ heading() }}
                </h2>
                @if (badge() !== null) {
                    <span class="shrink-0 text-[0.625rem] tabular-nums text-text-muted">{{ badge() }}</span>
                }
            </button>

            <!-- Left out of the document rather than hidden with a class, so a collapsed section takes no space and its controls are not tab-reachable. -->
            @if (open()) {
                <div class="mt-1.5">
                    <ng-content />
                </div>
            }
        </section>
    `,
})
export class WikiRailSectionComponent {
    /** Already translated by the caller - the section does not know which key it came from. */
    readonly heading = input.required<string>();
    /** Stable across pages, so collapse state follows the section and not the page. */
    readonly stateKey = input.required<string>();
    /** A count shown beside the heading while collapsed. Null hides it. */
    readonly badge = input<number | string | null>(null);
    readonly openByDefault = input(true);

    protected readonly open = signal(true);

    constructor() {
        effect(() => {
            const stored = readOpen(this.stateKey());
            this.open.set(stored ?? this.openByDefault());
        });
    }

    protected toggle(): void {
        const next = !this.open();
        this.open.set(next);
        writeOpen(this.stateKey(), next);
    }
}

function readOpen(key: string): boolean | null {
    try {
        const raw = localStorage.getItem(STATE_KEY_PREFIX + key);
        return raw === null ? null : raw === '1';
    } catch {
        // Private-mode storage. The section simply opens at its default every time.
        return null;
    }
}

function writeOpen(key: string, open: boolean): void {
    try {
        localStorage.setItem(STATE_KEY_PREFIX + key, open ? '1' : '0');
    } catch {
        // Collapse state does not persist. Not worth surfacing.
    }
}
