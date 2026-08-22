import {ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked} from '@angular/core';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {ConfirmationService, MessageService} from 'primeng/api';
import {ConfirmDialog} from 'primeng/confirmdialog';
import {ProfileService} from '../../../../../../services/profile.service';
import {CanvasEditorService} from '../../../../../../services/canvas-editor.service';
import {ProfileCanvasStore} from '../../../../../../stores/profile-canvas.store';
import {ProfileCanvasComponent} from '../../../../../../components/profile-canvas/profile-canvas.component';
import {
    definitionFor,
    WIDGET_REGISTRY,
    WidgetDefinition,
} from '../../../../../../components/profile-canvas/widget-registry';
import {emptyCanvas} from '../../../../../../models/profile-canvas';
import {WidgetPropertiesComponent} from './widget-properties.component';

@Component({
    selector: 'app-canvas-editor',
    imports: [TranslateModule, ProfileCanvasComponent, WidgetPropertiesComponent, ConfirmDialog],
    templateUrl: './canvas-editor.component.html',
    providers: [ConfirmationService],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CanvasEditorComponent {
    protected readonly editor = inject(CanvasEditorService);
    protected readonly store = inject(ProfileCanvasStore);
    protected readonly selectedId = signal<string | null>(null);
    protected readonly dragIndex = signal<number | null>(null);
    protected readonly overIndex = signal<number | null>(null);

    private profiles = inject(ProfileService);
    private toast = inject(MessageService);
    private confirm = inject(ConfirmationService);
    private translate = inject(TranslateService);

    protected readonly owner = this.profiles.ownProfile;

    protected readonly selected = computed(
        () => this.editor.draft()?.widgets.find(widget => widget.id === this.selectedId()) ?? null,
    );

    protected get registry(): readonly WidgetDefinition[] {
        // A getter, not a field: an imported const read as a class field is undefined under Vite.
        return WIDGET_REGISTRY;
    }

    constructor() {
        effect(() => {
            const profile = this.owner();
            if (!profile) return;

            untracked(() => {
                this.store.ensureLoaded(profile.id);
                this.editor.begin(this.store.canvasFor(profile.id) ?? emptyCanvas(profile.id));
            });
        });
    }

    protected insert(type: string): void {
        this.editor.insert(type);
        const widgets = this.editor.draft()?.widgets ?? [];
        this.selectedId.set(widgets[widgets.length - 1]?.id ?? null);
    }

    protected labelFor(type: string): string {
        return definitionFor(type)?.labelKey ?? type;
    }

    protected onDragOver(event: DragEvent, index: number): void {
        // Without preventDefault the drop never fires: the default is "not a drop target".
        event.preventDefault();
        this.overIndex.set(index);
    }

    protected onDrop(event: DragEvent, index: number): void {
        event.preventDefault();
        const from = this.dragIndex();
        this.dragIndex.set(null);
        this.overIndex.set(null);
        if (from === null || from === index) return;

        const id = this.editor.draft()?.widgets[from]?.id;
        if (id) this.editor.move(id, index - from);
    }

    protected remove(id: string): void {
        this.editor.remove(id);
        if (this.selectedId() === id) this.selectedId.set(null);
    }

    protected save(): void {
        const draft = this.editor.draft();
        if (!draft || !this.editor.dirty()) return;

        this.store.save(draft).subscribe({
            next: saved => {
                this.editor.begin(saved);
                this.toast.add({
                    severity: 'success',
                    summary: this.translate.instant('PROFILE.CANVAS.EDITOR.SAVED'),
                });
            },
            error: () =>
                this.toast.add({
                    severity: 'error',
                    summary: this.translate.instant('PROFILE.CANVAS.EDITOR.SAVE_FAILED'),
                }),
        });
    }

    protected confirmDiscard(): void {
        if (!this.editor.dirty()) return;
        this.confirm.confirm({
            header: this.translate.instant('PROFILE.CANVAS.EDITOR.DISCARD'),
            message: this.translate.instant('PROFILE.CANVAS.EDITOR.DISCARD_CONFIRM'),
            acceptButtonProps: {severity: 'danger', size: 'small'},
            rejectButtonProps: {severity: 'secondary', outlined: true, size: 'small'},
            accept: () => {
                this.editor.discard();
                this.selectedId.set(null);
            },
        });
    }

    /** Arrow keys move the selection; with a modifier they move the widget instead. */
    protected onKeydown(event: KeyboardEvent, id: string): void {
        const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
        const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
        if (!forward && !backward) return;

        event.preventDefault();
        const delta = forward ? 1 : -1;

        if (event.shiftKey || event.ctrlKey || event.metaKey) {
            this.editor.move(id, delta);
            return;
        }

        const widgets = this.editor.draft()?.widgets ?? [];
        const next = widgets[widgets.findIndex(widget => widget.id === id) + delta];
        if (next) this.selectedId.set(next.id);
    }
}
