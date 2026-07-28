import {Component, computed, effect, inject, input, signal} from '@angular/core';
import {Avatar} from 'primeng/avatar';
import {IonAvatar} from '@ionic/angular/standalone';
import {takeUntilDestroyed, toObservable} from '@angular/core/rxjs-interop';
import {ProfileService} from '../../services/profile.service';
import {PlatformService} from '../../services/platform.service';

@Component({
    selector: 'app-avatar',
    imports: [Avatar, IonAvatar],
    template: `
    @if (platformService.isMobile) {
      <ion-avatar [style]="ionSizeStyle()">
        @if (imageUrl()) {
          <img [src]="imageUrl()" [alt]="displayLabel() ?? ''" (error)="onError()" />
        } @else if (displayLabel()) {
          <div class="w-full h-full flex items-center justify-center bg-[var(--color-brand)] text-white font-semibold text-sm rounded-full">
            {{ displayLabel() }}
          </div>
        } @else {
          <div class="w-full h-full flex items-center justify-center bg-white/10 rounded-full">
            <i class="pi pi-user text-white/40 text-xs"></i>
          </div>
        }
      </ion-avatar>
    } @else {
      <p-avatar
        [image]="imageUrl()"
        [label]="displayLabel()"
        [icon]="displayIcon()"
        shape="circle"
        [size]="size()"
        [styleClass]="styleClass()"
        (onImageError)="onError()"
      />
    }
  `,
})
export class AppAvatarComponent {
    userId = input<string | undefined>(undefined);
    label = input<string | undefined>(undefined);
    size = input<'normal' | 'large' | 'xlarge' | undefined>(undefined);
    styleClass = input<string | undefined>(undefined);
    public platformService = inject(PlatformService);
    protected ionSizeStyle = computed(() => {
        const s = this.size();
        const dim = s === 'large' ? '3rem' : s === 'xlarge' ? '4rem' : '2rem';
        return {width: dim, height: dim};
    });
    protected displayIcon = computed((): string | undefined => {
        if (this.imageUrl()) return undefined;
        return this.displayLabel() ? undefined : 'pi pi-user';
    });
    private profileService = inject(ProfileService);
    private imageError = signal(false);
    private profile = computed(() =>
        this.userId() ? this.profileService.getCachedByUserId(this.userId()!) : undefined
    );
    protected imageUrl = computed((): string | undefined =>
        this.imageError() ? undefined : this.profile()?.avatarUrl
    );
    protected displayLabel = computed((): string | undefined => {
        if (this.imageUrl()) return undefined;
        return this.label() ?? this.profile()?.userName?.[0]?.toUpperCase();
    });

    constructor() {
        // Trigger profile fetch if not yet cached
        effect(() => {
            const id = this.userId();
            if (id) this.profileService.resolveByUserId(id);
        });

        // Reset 404 flag whenever the profile object changes (new user or avatar updated)
        toObservable(this.profile)
            .pipe(takeUntilDestroyed())
            .subscribe(() => this.imageError.set(false));
    }

    protected onError(): void {
        this.imageError.set(true);
    }
}
