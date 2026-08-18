import {ChangeDetectionStrategy, Component, computed, inject, input, output, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Dialog} from 'primeng/dialog';
import {PrimeTemplate} from 'primeng/api';
import {SceneService} from '../../../../services/scene.service';
import {ToastService} from '../../../../services/toast.service';
import {SceneDto, SceneStatus} from '../../../../dtos/response/scene.dto';
import {sceneTally} from '../scene-tally';

/**
 * Ending a scene. It is the last page of a chapter rather than a delete, so the dialog shows what
 * the scene amounted to and offers a line to close it with.
 */
@Component({
    selector: 'app-scene-conclude-dialog',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [FormsModule, TranslateModule, Dialog, PrimeTemplate],
    templateUrl: './scene-conclude-dialog.component.html',
    styleUrl: './scene-conclude-dialog.component.css',
})
export class SceneConcludeDialogComponent {
    readonly guildId = input.required<string>();
    readonly scene = input.required<SceneDto>();
    readonly closed = output<void>();

    private readonly scenes = inject(SceneService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);

    protected readonly note = signal('');
    protected readonly saving = signal(false);

    protected readonly tally = computed(() => sceneTally(this.scene()));

    protected conclude(): void {
        if (this.saving()) return;
        this.saving.set(true);
        this.scenes
            .update(this.guildId(), this.scene().channelId, {
                status: SceneStatus.Concluded,
                conclusionNote: this.note().trim() || null,
            })
            .subscribe({
                next: () => {
                    this.saving.set(false);
                    this.toast.success(this.translate.instant('SCENE.TOAST.CONCLUDED'));
                    this.closed.emit();
                },
                error: err => {
                    this.saving.set(false);
                    this.toast.httpError(this.translate.instant('SCENE.TOAST.FAILED'), err);
                },
            });
    }
}
