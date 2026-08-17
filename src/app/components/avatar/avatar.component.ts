import {Component, computed, effect, inject, input, signal} from '@angular/core';
import {Avatar} from 'primeng/avatar';
import {takeUntilDestroyed, toObservable} from '@angular/core/rxjs-interop';
import {ProfileService} from '../../services/profile.service';
import {OsInfo} from '../../platform/ports/os-info.port';

@Component({
    selector: 'app-avatar',
    imports: [Avatar],
    template: `
        @if (os.isMobile) {
            <div class="block rounded-full overflow-hidden shrink-0" [style]="avatarSizeStyle()">
                @if (imageUrl()) {
                    <img
                        class="w-full h-full object-cover"
                        [src]="imageUrl()"
                        [alt]="displayLabel() ?? ''"
                        (error)="onError()"
                    />
                } @else if (displayLabel()) {
                    <div
                        class="w-full h-full flex items-center justify-center bg-[var(--color-brand)] text-white font-semibold text-sm rounded-full"
                    >
                        {{ displayLabel() }}
                    </div>
                } @else {
                    <div class="w-full h-full flex items-center justify-center bg-white/10 rounded-full">
                        <i class="pi pi-user text-text-muted text-xs"></i>
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
    readonly userId = input<string | undefined>(undefined);
    readonly label = input<string | undefined>(undefined);
    readonly size = input<'normal' | 'large' | 'xlarge' | undefined>(undefined);
    readonly styleClass = input<string | undefined>(undefined);
    /** The form factor, from the port. Public because the template above reads it. */
    public os = inject(OsInfo);
    /** The mobile avatar's box. Must stay an inline style: Tailwind purges class names assembled at runtime. */
    protected readonly avatarSizeStyle = computed(() => {
        const s = this.size();
        const dim = s === 'large' ? '3rem' : s === 'xlarge' ? '4rem' : '2rem';
        return {width: dim, height: dim};
    });
    protected readonly displayIcon = computed((): string | undefined => {
        if (this.imageUrl()) return undefined;
        return this.displayLabel() ? undefined : 'pi pi-user';
    });
    private profileService = inject(ProfileService);
    private readonly imageError = signal(false);
    private readonly profile = computed(() =>
        this.userId() ? this.profileService.getCachedByUserId(this.userId()!) : undefined,
    );
    protected readonly imageUrl = computed((): string | undefined =>
        this.imageError() ? undefined : this.profile()?.avatarUrl,
    );
    protected readonly displayLabel = computed((): string | undefined => {
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
