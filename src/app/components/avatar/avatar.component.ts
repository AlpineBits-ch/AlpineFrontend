import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { Avatar } from 'primeng/avatar';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { ProfileService } from '../../services/profile.service';

@Component({
  selector: 'app-avatar',
  imports: [Avatar],
  template: `
    <p-avatar
      [image]="imageUrl()"
      [label]="displayLabel()"
      [icon]="displayIcon()"
      shape="circle"
      [size]="size()"
      [styleClass]="styleClass()"
      (onImageError)="onError()"
    />
  `,
})
export class AppAvatarComponent {
  userId    = input<string | undefined>(undefined);
  label     = input<string | undefined>(undefined);
  size      = input<'normal' | 'large' | 'xlarge' | undefined>(undefined);
  styleClass = input<string | undefined>(undefined);

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

  protected displayIcon = computed((): string | undefined => {
    if (this.imageUrl()) return undefined;
    return this.displayLabel() ? undefined : 'pi pi-user';
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
