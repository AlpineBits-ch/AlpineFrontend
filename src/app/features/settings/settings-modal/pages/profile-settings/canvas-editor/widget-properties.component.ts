import {ChangeDetectionStrategy, Component, computed, inject, input, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {TranslateModule} from '@ngx-translate/core';
import {Select} from 'primeng/select';
import {CanvasVisibility, CanvasWidgetDto} from '../../../../../../dtos/response/profile-canvas.dto';
import {CanvasEditorService} from '../../../../../../services/canvas-editor.service';
import {ProfileCanvasApiService} from '../../../../../../services/profile-canvas-api.service';
import {definitionFor, WidgetField} from '../../../../../../components/profile-canvas/widget-registry';
import {Footprint, MAX_CARD_WIDGETS} from '../../../../../../models/profile-canvas';

const VISIBILITIES: readonly CanvasVisibility[] = ['everyone', 'friends', 'mutuals'];

interface CanvasImage {
    imageId: string;
    alt: string;
}

/** Feature-detected: some runtimes lack `Intl.supportedValuesOf`, in which case the picker falls back to a plain input. */
function supportedTimeZoneIds(): string[] {
    if (typeof (Intl as {supportedValuesOf?: unknown}).supportedValuesOf !== 'function') return [];
    try {
        return Intl.supportedValuesOf('timeZone');
    } catch {
        return [];
    }
}

@Component({
    selector: 'app-widget-properties',
    imports: [FormsModule, Select, TranslateModule],
    templateUrl: './widget-properties.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WidgetPropertiesComponent {
    readonly widget = input.required<CanvasWidgetDto>();

    protected readonly uploadFailed = signal(false);

    private editorSvc = inject(CanvasEditorService);
    private api = inject(ProfileCanvasApiService);

    private readonly zoneIds = supportedTimeZoneIds();

    protected get visibilities(): readonly CanvasVisibility[] {
        return VISIBILITIES;
    }

    protected get timeZonePickerAvailable(): boolean {
        return this.zoneIds.length > 0;
    }

    /** Locked once two OTHER widgets already wear the badge; never locked against releasing this widget's own. */
    protected readonly cardLimitReached = computed(() => {
        const widgets = this.editorSvc.draft()?.widgets ?? [];
        const id = this.widget().id;
        const others = widgets.filter(w => w.id !== id && w.card).length;
        return others >= MAX_CARD_WIDGETS;
    });

    protected readonly timeZoneOptions = computed(() => {
        const options = this.zoneIds.map(id => ({label: id, value: id}));
        const current = this.config()['timeZone'];
        if (typeof current === 'string' && current && !this.zoneIds.includes(current)) {
            return [{label: current, value: current}, ...options];
        }
        return options;
    });

    protected readonly fields = computed(() => definitionFor(this.widget().type)?.fields ?? []);

    protected readonly footprints = computed(() => definitionFor(this.widget().type)?.footprints ?? []);

    protected readonly config = computed(() => this.widget().config as Record<string, unknown>);

    protected fieldId(field: WidgetField): string {
        return `canvas-widget-field-${this.widget().id}-${field.key}`;
    }

    protected valueOf(field: WidgetField): string {
        const value = this.config()[field.key];
        return typeof value === 'string' ? value : '';
    }

    /** Values are optional, not just `string`: an older client or a future registry column can
     * store a row missing one of the current columns, and the template must not print "undefined". */
    protected rowsOf(field: WidgetField): Record<string, string | undefined>[] {
        const value = this.config()[field.key];
        return Array.isArray(value) ? (value as Record<string, string | undefined>[]) : [];
    }

    protected imagesOf(field: WidgetField): CanvasImage[] {
        const value = this.config()[field.key];
        return Array.isArray(value) ? (value as CanvasImage[]) : [];
    }

    protected imageUrl(imageId: string): string {
        return this.api.imageUrl(imageId);
    }

    protected setText(field: WidgetField, event: Event): void {
        const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
        this.editorSvc.patchConfig(this.widget().id, {[field.key]: value});
    }

    protected setTimeZone(field: WidgetField, value: string): void {
        this.editorSvc.patchConfig(this.widget().id, {[field.key]: value});
    }

    protected addRow(field: WidgetField): void {
        if (field.kind !== 'rows' || this.rowsOf(field).length >= field.max) return;
        const blank = Object.fromEntries(field.columns.map(column => [column.key, '']));
        this.editorSvc.patchConfig(this.widget().id, {[field.key]: [...this.rowsOf(field), blank]});
    }

    protected removeRow(field: WidgetField, index: number): void {
        const rows = this.rowsOf(field).filter((_, i) => i !== index);
        this.editorSvc.patchConfig(this.widget().id, {[field.key]: rows});
    }

    protected setCell(field: WidgetField, index: number, key: string, event: Event): void {
        const value = (event.target as HTMLInputElement).value;
        const rows = this.rowsOf(field).map((row, i) => (i === index ? {...row, [key]: value} : row));
        this.editorSvc.patchConfig(this.widget().id, {[field.key]: rows});
    }

    protected removeImage(field: WidgetField, index: number): void {
        const items = this.imagesOf(field).filter((_, i) => i !== index);
        this.editorSvc.patchConfig(this.widget().id, {[field.key]: items});
    }

    /** Reads the editor's own current draft, not this component's `widget` input: two uploads
     * started before either resolves would otherwise both see the input's stale item count and
     * both append, blowing past the cap. */
    private currentImages(field: WidgetField): CanvasImage[] {
        const widget = this.editorSvc.draft()?.widgets.find(w => w.id === this.widget().id);
        const value = (widget?.config as Record<string, unknown> | undefined)?.[field.key];
        return Array.isArray(value) ? (value as CanvasImage[]) : [];
    }

    protected upload(field: WidgetField, event: Event): void {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;

        this.uploadFailed.set(false);
        this.api.uploadImage(file).subscribe({
            next: image => {
                if (field.kind === 'images') {
                    const items = this.currentImages(field);
                    if (items.length < field.max) {
                        this.editorSvc.patchConfig(this.widget().id, {
                            [field.key]: [...items, {imageId: image.imageId, alt: ''}],
                        });
                    }
                } else {
                    this.editorSvc.patchConfig(this.widget().id, {[field.key]: image.imageId});
                }
                input.value = '';
            },
            error: () => this.uploadFailed.set(true),
        });
    }

    protected resize(footprint: Footprint): void {
        this.editorSvc.resize(this.widget().id, footprint);
    }

    protected setVisibility(visibility: CanvasVisibility): void {
        this.editorSvc.setVisibility(this.widget().id, visibility);
    }

    protected toggleCard(): void {
        this.editorSvc.setCard(this.widget().id, !this.widget().card);
    }

    protected visibilityKey(visibility: CanvasVisibility): string {
        return `PROFILE.CANVAS.EDITOR.VISIBILITY_${visibility.toUpperCase()}`;
    }
}
