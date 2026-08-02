import {Component, computed, effect, inject, input, signal} from '@angular/core';
import {Avatar} from 'primeng/avatar';
import {takeUntilDestroyed, toObservable} from '@angular/core/rxjs-interop';
import {ProfileService} from '../../services/profile.service';
import {PlatformService} from '../../services/platform.service';

@Component({
    selector: 'app-avatar',
    imports: [Avatar],
    template: `
    @if (platformService.isMobile) {
      <!--
        Was an <ion-avatar>, which is a block element with a 50% radius, hidden overflow and an
        img forced to cover. All four are one Tailwind class each, so the element carried no
        behaviour worth a dependency - the <img> rules just have to move onto the img, because
        they came from ion-avatar's shadow styles rather than from anything here.
      -->
      <div class="block rounded-full overflow-hidden shrink-0" [style]="avatarSizeStyle()">
        @if (imageUrl()) {
          <img class="w-full h-full object-cover"
               [src]="imageUrl()" [alt]="displayLabel() ?? ''" (error)="onError()" />
        } @else if (displayLabel()) {
          <div class="w-full h-full flex items-center justify-center bg-[var(--color-brand)] text-white font-semibold text-sm rounded-full">
            {{ displayLabel() }}
          </div>
        } @else {
          <div class="w-full h-full flex items-center justify-center bg-white/10 rounded-full">
            <i class="pi pi-user text-white/40 text-xs"></i>
          </div>
        }
      </div>
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
    /**
     * The mobile avatar's box, in the same three sizes PrimeNG's `size` names.
     *
     * Kept as an inline style rather than folded into the class list: the sizes are driven by an
     * input, and Tailwind cannot see class names assembled at runtime, so a computed class string
     * would be purged from the production build and silently render at 0x0.
     */
    protected avatarSizeStyle = computed(() => {
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
