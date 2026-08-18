import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {DatePipe} from '@angular/common';
import {TranslateModule} from '@ngx-translate/core';
import {SceneDto} from '../../../../dtos/response/scene.dto';
import {sceneTally} from '../scene-tally';

/**
 * The mark at the end of a concluded scene. Ending a scene is the last page of a chapter, so it is
 * set as one rather than drawn as a greyed-out bar.
 */
@Component({
    selector: 'app-scene-conclusion',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [TranslateModule, DatePipe],
    template: `
        <section class="conclusion">
            <div class="conclusion-rule">
                <span aria-hidden="true" class="conclusion-mark"></span>
            </div>

            <h2 class="conclusion-title">{{ 'SCENE.END.TITLE' | translate: {name: scene().name} }}</h2>

            @if (scene().conclusionNote; as note) {
                <p class="conclusion-note">{{ note }}</p>
            }

            @if (tally().length) {
                <p class="conclusion-tally">
                    @for (entry of tally(); track entry.labelKey; let last = $last) {
                        <span class="conclusion-tally-value">{{ entry.value }}</span>
                        <span class="conclusion-tally-label">{{ entry.labelKey | translate }}</span>
                        @if (!last) {
                            <span aria-hidden="true" class="conclusion-dot">·</span>
                        }
                    }
                </p>
            }

            @if (scene().concludedAt; as at) {
                <p class="conclusion-date">{{ at | date: 'longDate' }}</p>
            }
        </section>
    `,
    styleUrl: './scene-conclusion.component.css',
})
export class SceneConclusionComponent {
    readonly scene = input.required<SceneDto>();

    protected readonly tally = computed(() => sceneTally(this.scene()));
}
