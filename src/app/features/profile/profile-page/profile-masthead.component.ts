import {
    ChangeDetectionStrategy,
    Component,
    computed,
    ElementRef,
    input,
    output,
    signal,
    viewChild,
} from '@angular/core';
import {DatePipe} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {TranslateModule} from '@ngx-translate/core';
import {Dialog} from 'primeng/dialog';
import {Select} from 'primeng/select';
import {AppAvatarComponent} from '../../../components/avatar/avatar.component';
import {ImageCropperComponent} from '../../../components/image-cropper/image-cropper.component';
import {UserNameStyleDirective} from '../../../directives/user-name-style.directive';
import {FONT_OPTIONS, FONT_STACKS, safeAccentColor} from '../../../models/profile-font.model';
import {cacheBustedUrl} from '../../../models/profile-image.model';
import {ProfileDto, ProfileFont} from '../../../dtos/response/profile.dto';

/** Banner, avatar, name and the appearance controls. Purely controlled: the page decides what "editing" means. */
@Component({
    selector: 'app-profile-masthead',
    imports: [
        AppAvatarComponent,
        TranslateModule,
        FormsModule,
        Dialog,
        ImageCropperComponent,
        Select,
        UserNameStyleDirective,
        DatePipe,
    ],
    templateUrl: './profile-masthead.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileMastheadComponent {
    readonly profile = input.required<ProfileDto>();
    readonly editing = input.required<boolean>();
    readonly saving = input.required<boolean>();
    readonly uploadingAvatar = input.required<boolean>();
    readonly uploadingBanner = input.required<boolean>();
    readonly bio = input.required<string>();
    readonly accentColor = input.required<string>();
    readonly font = input.required<ProfileFont>();

    readonly editStarted = output<void>();
    readonly cancelled = output<void>();
    readonly saved = output<void>();
    readonly bioChanged = output<string>();
    readonly accentColorChanged = output<string>();
    readonly fontChanged = output<ProfileFont>();
    readonly avatarCropped = output<File>();
    readonly bannerCropped = output<File>();
    readonly avatarRemoveRequested = output<void>();

    protected readonly avatarCropVisible = signal(false);
    protected readonly avatarCropSrc = signal('');

    protected readonly bannerCropVisible = signal(false);
    protected readonly bannerCropSrc = signal('');

    private readonly avatarFileInputRef = viewChild<ElementRef<HTMLInputElement>>('avatarFileInput');
    private readonly bannerFileInputRef = viewChild<ElementRef<HTMLInputElement>>('bannerFileInput');

    protected readonly bannerUrl = computed((): string | undefined => {
        const profile = this.profile();
        return cacheBustedUrl(profile.bannerUrl, profile.updatedAt);
    });

    protected readonly bannerFallback = computed(() => safeAccentColor(this.profile().accentColor));

    protected readonly hasAvatar = computed(() => !!this.profile().avatarUrl);

    protected readonly safeAccentColor = safeAccentColor;

    protected readonly fontPreviewStack = computed(() => {
        const font = this.font();
        return font !== ProfileFont.Default ? FONT_STACKS[font] : null;
    });

    protected get fontOptions(): {value: ProfileFont; label: string}[] {
        return FONT_OPTIONS;
    }

    protected get fontStacks(): Record<ProfileFont, string> {
        return FONT_STACKS;
    }

    protected pickAvatarFile(): void {
        this.avatarFileInputRef()?.nativeElement.click();
    }

    protected onAvatarFileSelected(event: Event): void {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => {
            this.avatarCropSrc.set(reader.result as string);
            this.avatarCropVisible.set(true);
        };
        reader.readAsDataURL(file);
    }

    protected onAvatarCropConfirmed(file: File): void {
        this.avatarCropVisible.set(false);
        this.avatarCropped.emit(file);
    }

    protected removeAvatar(): void {
        this.avatarRemoveRequested.emit();
    }

    protected pickBannerFile(): void {
        this.bannerFileInputRef()?.nativeElement.click();
    }

    protected onBannerFileSelected(event: Event): void {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => {
            this.bannerCropSrc.set(reader.result as string);
            this.bannerCropVisible.set(true);
        };
        reader.readAsDataURL(file);
    }

    protected onBannerCropConfirmed(file: File): void {
        this.bannerCropVisible.set(false);
        this.bannerCropped.emit(file);
    }
}
