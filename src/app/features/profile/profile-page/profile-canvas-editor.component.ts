import {
    afterNextRender,
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    ElementRef,
    inject,
    Injector,
    input,
    signal,
    viewChild,
} from '@angular/core';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {
    ProfileCanvasComponent,
    WidgetSelectedEvent,
} from '../../../components/profile-canvas/profile-canvas.component';
import {definitionFor, WIDGET_REGISTRY} from '../../../components/profile-canvas/widget-registry';
import {ContextMenuComponent} from '../../../shared/context-menu/context-menu.component';
import {MenuItem} from '../../../shared/context-menu/context-menu.model';
import {CanvasEditorService} from '../../../services/canvas-editor.service';
import {CanvasVisibility, CanvasWidgetDto, ProfileCanvasDto} from '../../../dtos/response/profile-canvas.dto';
import {ProfileDto} from '../../../dtos/response/profile.dto';
import {CANVAS_COLUMNS, isSpacer} from '../../../models/profile-canvas';
import {WidgetEditorPopoverComponent} from './widget-editor-popover.component';
import {CanvasLatticeComponent} from './canvas-lattice.component';

/** Who the canvas is being previewed as. The owner ('me') is the only one who sees every visibility. */
export type PreviewViewer = 'me' | 'friend' | 'mutual' | 'stranger';

const PREVIEW_VIEWERS: readonly PreviewViewer[] = ['me', 'friend', 'mutual', 'stranger'];

const VIEWER_VISIBILITY: Readonly<Record<PreviewViewer, readonly CanvasVisibility[]>> = {
    me: ['everyone', 'friends', 'mutuals'],
    friend: ['everyone', 'friends'],
    mutual: ['everyone', 'mutuals'],
    stranger: ['everyone'],
};

/**
 * The canvas, the lattice, tile selection and the visitor preview. Inserting a widget and picking
 * types both go through CanvasEditorService directly, the same way WidgetPropertiesComponent and
 * WidgetEditorPopoverComponent already reach it for the widgets they edit and delete.
 */
@Component({
    selector: 'app-profile-canvas-editor',
    imports: [
        ProfileCanvasComponent,
        CanvasLatticeComponent,
        WidgetEditorPopoverComponent,
        ContextMenuComponent,
        TranslateModule,
    ],
    templateUrl: './profile-canvas-editor.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileCanvasEditorComponent {
    readonly canvas = input<ProfileCanvasDto>();
    readonly owner = input.required<ProfileDto>();
    readonly editing = input.required<boolean>();

    private readonly editor = inject(CanvasEditorService);
    private readonly translate = inject(TranslateService);
    private readonly injector = inject(Injector);

    private readonly canvasHost = viewChild<ElementRef<HTMLElement>>('canvasHost');
    private readonly widgetMenu = viewChild.required<ContextMenuComponent>('widgetMenu');

    protected get canvasColumns(): number {
        return CANVAS_COLUMNS;
    }

    // Read from the same normalised widgets the grid itself renders, so the lattice can never
    // claim more rows exist than the canvas actually has.
    protected readonly canvasRowCount = computed(() => {
        const widgets = this.canvas()?.widgets ?? [];
        return widgets.reduce((max, widget) => Math.max(max, widget.y + widget.h), 1);
    });

    protected readonly selectedWidgetId = signal<string | null>(null);
    protected readonly selectedTileEl = signal<HTMLElement | null>(null);
    // Escape hides the popover but leaves selectedWidgetId alone, so the tile stays visibly
    // selected for a keyboard user; only clearSelection() actually deselects.
    private readonly editorHidden = signal(false);

    protected readonly popoverWidget = computed(() => {
        const id = this.selectedWidgetId();
        if (!id || this.editorHidden()) return null;
        return this.canvas()?.widgets.find(widget => widget.id === id) ?? null;
    });

    protected readonly addWidgetItems = computed((): MenuItem[] =>
        WIDGET_REGISTRY.map(definition => ({
            label: this.translate.instant(definition.labelKey),
            icon: 'pi ' + definition.icon,
            disabled: !this.editor.canInsert(definition.type),
            command: () => this.insertWidget(definition.type),
        })),
    );

    // Own-profile check: 'me' always sees every visibility, so this stays a pure read over the
    // canvas already loaded. Nothing here ever calls into CanvasEditorService.
    protected readonly previewAs = signal<PreviewViewer>('me');

    protected get previewViewers(): readonly PreviewViewer[] {
        return PREVIEW_VIEWERS;
    }

    protected readonly hiddenWidgetIds = computed(() => {
        const allowed = VIEWER_VISIBILITY[this.previewAs()];
        const widgets = this.canvas()?.widgets ?? [];
        return new Set(
            widgets.filter(widget => !allowed.includes(widget.visibility)).map(widget => widget.id),
        );
    });

    protected readonly hiddenWidgets = computed(() => {
        const hidden = this.hiddenWidgetIds();
        return (this.canvas()?.widgets ?? []).filter(widget => hidden.has(widget.id));
    });

    protected readonly hiddenCount = computed(() => this.hiddenWidgetIds().size);

    constructor() {
        // The page has no other handle on this child's own selection state, so leaving edit mode
        // is the one external event that clears it.
        effect(() => {
            if (!this.editing()) this.clearSelection();
        });

        // Reaches into ProfileCanvasComponent's own tiles by the data-widget-id contract, since
        // that component takes no dimming input. Every widget stays mounted; only opacity and
        // aria-hidden change, so nothing disappears from the layout or the accessibility tree.
        effect(() => {
            this.syncDimming(this.hiddenWidgetIds());
        });
    }

    protected setPreviewAs(viewer: PreviewViewer): void {
        this.previewAs.set(viewer);
    }

    protected previewViewerKey(viewer: PreviewViewer): string {
        return `PROFILE.CANVAS.EDITOR.PREVIEW_${viewer.toUpperCase()}`;
    }

    protected hiddenWidgetAnnouncement(widget: CanvasWidgetDto): string {
        const type = this.translate.instant(definitionFor(widget.type)?.labelKey ?? '');
        return this.translate.instant('PROFILE.CANVAS.EDITOR.PREVIEW_HIDDEN_WIDGET', {type});
    }

    private syncDimming(hidden: ReadonlySet<string>): void {
        const host = this.canvasHost()?.nativeElement;
        if (!host) return;

        host.querySelectorAll<HTMLElement>('[data-widget-id]').forEach(tile => {
            const id = tile.dataset['widgetId'];
            const dim = !!id && hidden.has(id);
            tile.style.opacity = dim ? '0.4' : '';
            if (dim) tile.setAttribute('aria-hidden', 'false');
            else tile.removeAttribute('aria-hidden');
        });
    }

    protected openWidgetMenu(event: MouseEvent): void {
        this.widgetMenu().toggle(event);
    }

    protected onWidgetSelected(event: WidgetSelectedEvent): void {
        if (this.selectedWidgetId() === event.id && !this.editorHidden()) {
            this.clearSelection();
            return;
        }
        this.selectedWidgetId.set(event.id);
        this.selectedTileEl.set(event.element);
        this.editorHidden.set(false);
    }

    protected onEditorEscaped(): void {
        this.editorHidden.set(true);
        this.selectedTileEl()?.focus();
    }

    protected onEditorDismissed(): void {
        this.clearSelection();
    }

    protected onEditorDeleted(): void {
        this.clearSelection();
    }

    private clearSelection(): void {
        this.selectedWidgetId.set(null);
        this.selectedTileEl.set(null);
        this.editorHidden.set(false);
    }

    // A spacer never becomes a selectable tile (ProfileCanvasComponent.tileSelectable agrees), so
    // inserting one leaves the selection alone instead of anchoring a popover nothing can open.
    private insertWidget(type: string): void {
        const inserted = this.editor.insert(type);
        if (!inserted || isSpacer(inserted)) return;

        afterNextRender(
            () => {
                const element = this.canvasHost()?.nativeElement.querySelector<HTMLElement>(
                    `[data-widget-id="${inserted.id}"]`,
                );
                if (!element) return;
                this.selectedWidgetId.set(inserted.id);
                this.selectedTileEl.set(element);
                this.editorHidden.set(false);
            },
            {injector: this.injector},
        );
    }
}
