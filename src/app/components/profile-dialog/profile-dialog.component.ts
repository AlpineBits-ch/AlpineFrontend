import {Component, inject, Input, OnChanges, Output, EventEmitter, signal, SimpleChanges} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {ProfileDto} from '../../dtos/response/profile.dto';
import {ProfileService} from '../../services/profile.service';
import {ProfileCardComponent} from '../profile-card/profile-card.component';
import {TranslateModule} from '@ngx-translate/core';

@Component({
    selector: 'app-profile-dialog',
    standalone: true,
    imports: [Dialog, ProfileCardComponent, TranslateModule],
    templateUrl: './profile-dialog.component.html',
    styleUrl: './profile-dialog.component.css',
})
export class ProfileDialogComponent implements OnChanges {
    @Input() userId: string | null = null;
    @Input() friendsSince: Date | null = null;
    @Output() visibleChange = new EventEmitter<boolean>();
    protected dialogVisible = false;
    protected profile = signal<ProfileDto | undefined>(undefined);
    protected avatarExpanded = false;
    protected avatarError = signal(false);
    private profileService = inject(ProfileService);

    ngOnChanges(changes: SimpleChanges): void {
        if (changes['userId']) {
            const id = this.userId;
            if (id) {
                this.dialogVisible = true;
                this.avatarError.set(false);
                const cached = this.profileService.getCachedByUserId(id);
                if (cached) {
                    this.profile.set(cached);
                } else {
                    this.profile.set(undefined);
                    this.profileService.getByUserId(id).subscribe(p => this.profile.set(p));
                }
            } else {
                this.dialogVisible = false;
                this.profile.set(undefined);
                this.avatarExpanded = false;
                this.avatarError.set(false);
            }
        }
    }

    protected onHide(): void {
        this.visibleChange.emit(false);
    }

    protected onAvatarClick(): void {
        if (this.profile()?.avatarUrl && !this.avatarError()) {
            this.avatarExpanded = true;
        }
    }

    protected onAvatarError(): void {
        this.avatarError.set(true);
    }
}
