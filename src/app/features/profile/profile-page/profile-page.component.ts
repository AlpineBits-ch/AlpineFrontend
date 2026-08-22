import {ChangeDetectionStrategy, Component, computed, effect, inject, untracked} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {AppAvatarComponent} from '../../../components/avatar/avatar.component';
import {ProfileCanvasComponent} from '../../../components/profile-canvas/profile-canvas.component';
import {ProfileService} from '../../../services/profile.service';
import {CanvasEditorService} from '../../../services/canvas-editor.service';
import {ProfileCanvasStore} from '../../../stores/profile-canvas.store';
import {safeAccentColor} from '../../../models/profile-font.model';
import {cacheBustedUrl} from '../../../models/profile-image.model';
import {emptyCanvas} from '../../../models/profile-canvas';

/** Own-profile page: identity strip above the canvas, view state only. Edit mode is Task 4. */
@Component({
    selector: 'app-profile-page',
    imports: [AppAvatarComponent, ProfileCanvasComponent, TranslateModule],
    templateUrl: './profile-page.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfilePageComponent {
    protected readonly profileService = inject(ProfileService);
    protected readonly canvasStore = inject(ProfileCanvasStore);
    protected readonly canvasEditor = inject(CanvasEditorService);

    protected readonly profile = computed(() => this.profileService.ownProfile());

    protected readonly bannerUrl = computed((): string | undefined => {
        const profile = this.profile();
        return cacheBustedUrl(profile?.bannerUrl, profile?.updatedAt);
    });

    protected readonly bannerFallback = computed(() => safeAccentColor(this.profile()?.accentColor));

    protected readonly canvas = computed(() => {
        const profile = this.profile();
        return profile ? (this.canvasStore.canvasFor(profile.id) ?? emptyCanvas(profile.id)) : undefined;
    });

    // ownProfile is a fresh object on every own-profile write (updateProfile, uploadAvatar,
    // uploadBanner, setSelfStatus), not just when the signed-in profile changes, so this must key
    // on the id rather than the profile object or it re-begins and drops an unsaved canvas draft.
    private readonly profileId = computed(() => this.profile()?.id);

    constructor() {
        effect(() => {
            const id = this.profileId();
            if (!id) return;

            untracked(() => {
                this.canvasStore.ensureLoaded(id);
                this.canvasEditor.begin(this.canvasStore.canvasFor(id) ?? emptyCanvas(id));
            });
        });
    }
}
