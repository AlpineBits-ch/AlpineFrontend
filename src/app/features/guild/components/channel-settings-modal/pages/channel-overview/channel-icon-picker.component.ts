import {
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    ElementRef,
    inject,
    input,
    model,
    signal,
    viewChild,
} from '@angular/core';
import {DOCUMENT} from '@angular/common';
import {TranslateModule} from '@ngx-translate/core';
import {ChannelType} from '../../../../../../dtos/response/guild.dto';
import {CHANNEL_ICON_CATALOG, CHANNEL_ICON_GROUPS} from '../../../../channel-icon-catalog';
import {CHANNEL_ICON_PALETTE} from '../../../../channel-icon-palette';
import {ChannelIconComponent} from '../../../channel-icon/channel-icon.component';
import {LucideIconComponent} from '../../../../../../components/lucide-icon/lucide-icon.component';

@Component({
    selector: 'app-channel-icon-picker',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [TranslateModule, ChannelIconComponent, LucideIconComponent],
    templateUrl: './channel-icon-picker.component.html',
    host: {
        '(document:click)': 'onDocumentClick($event)',
        '(document:keydown.escape)': 'close()',
    },
    styles: `
        /* Top layer, so the dialog's transform and its overflow cannot reach it. A plain fixed
           panel is both mispositioned and clipped inside p-dialog. Every visual lives here rather
           than in utility classes, because the UA sheet's own [popover] rules would otherwise
           fight them on equal specificity. */
        .picker-panel {
            position: fixed;
            inset: auto;
            margin: 0;
            padding: 0.75rem;
            border: 1px solid var(--color-border);
            border-radius: 0.75rem;
            background: var(--color-card);
            color: inherit;
            overflow: visible;
            box-shadow:
                0 8px 28px rgb(0 0 0 / 0.55),
                0 2px 8px rgb(0 0 0 / 0.3);
        }

        .picker-panel:not(:popover-open) {
            display: none;
        }

        /* The chosen icon, in the same idiom an active module row uses in the sidebar. */
        .is-chosen {
            background: color-mix(in srgb, var(--color-brand) 30%, transparent);
            box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-brand) 55%, transparent);
            color: var(--color-brand-dim);
        }
    `,
})
export class ChannelIconPickerComponent {
    /** `''` means the channel type's own icon. */
    readonly icon = model('');
    /** `''` means the uniform default colour. */
    readonly iconColor = model('');
    readonly channelType = input.required<ChannelType>();

    protected readonly open = signal(false);
    protected readonly search = signal('');

    protected get palette() {
        return CHANNEL_ICON_PALETTE;
    }

    protected readonly preview = computed(() => ({
        type: this.channelType(),
        icon: this.icon() || undefined,
        iconColor: this.iconColor() || undefined,
    }));

    protected readonly groups = computed(() => {
        const term = this.search().trim().toLowerCase();
        const matching = term
            ? CHANNEL_ICON_CATALOG.filter(e => e.name.includes(term))
            : CHANNEL_ICON_CATALOG;
        return CHANNEL_ICON_GROUPS.map(group => ({
            group,
            entries: matching.filter(e => e.group === group),
        })).filter(g => g.entries.length > 0);
    });

    /* The settings modal scrolls its body inside an overflow-hidden shell, so an absolutely
       positioned panel is clipped by it. Fixed placement escapes that, at the cost of having
       to follow the trigger on scroll and resize. */
    protected readonly panel = signal({top: 0, left: 0, width: 0});

    private readonly host = inject(ElementRef<HTMLElement>);
    private readonly doc = inject(DOCUMENT);

    /** Roughly the panel's tallest rendered height, used only to decide whether it opens upward. */
    private get panelHeight(): number {
        return 420;
    }

    private readonly panelEl = viewChild<ElementRef<HTMLElement>>('panelEl');

    protected toggle(): void {
        const opening = !this.open();
        if (opening) this.place();
        this.open.set(opening);
        this.syncPopover(opening);
    }

    /** jsdom has no Popover API, so every call is guarded rather than assumed. */
    private syncPopover(show: boolean): void {
        const el = this.panelEl()?.nativeElement;
        if (!el || typeof el.showPopover !== 'function') return;
        const isOpen = el.matches(':popover-open');
        if (show && !isOpen) el.showPopover();
        if (!show && isOpen) el.hidePopover();
    }

    private place(): void {
        const rect = this.host.nativeElement.getBoundingClientRect();
        const view = this.doc.defaultView!;
        const below = rect.bottom + 8;
        const flips = below + this.panelHeight > view.innerHeight;

        this.panel.set({
            top: flips ? Math.max(8, rect.top - this.panelHeight - 8) : below,
            left: rect.left,
            width: rect.width,
        });
    }

    constructor() {
        // Capture phase, because the modal's own scroller does not bubble a scroll event.
        const follow = () => {
            if (this.open()) this.place();
        };
        this.doc.addEventListener('scroll', follow, true);
        this.doc.defaultView!.addEventListener('resize', follow);
        inject(DestroyRef).onDestroy(() => {
            this.doc.removeEventListener('scroll', follow, true);
            this.doc.defaultView!.removeEventListener('resize', follow);
        });
    }

    /** The popover stays a DOM descendant of the host even in the top layer, so this covers both. */
    protected onDocumentClick(event: MouseEvent): void {
        if (!this.open()) return;
        if (!this.host.nativeElement.contains(event.target as Node)) this.close();
    }

    protected close(): void {
        this.open.set(false);
        this.syncPopover(false);
    }

    protected choose(name: string): void {
        this.icon.set(name);
        this.close();
    }

    protected clearIcon(): void {
        this.icon.set('');
        this.close();
    }

    protected onSearch(event: Event): void {
        this.search.set((event.target as HTMLInputElement).value);
    }
}
