import { Component, inject, Input, OnChanges, Output, EventEmitter, signal, computed, SimpleChanges, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Dialog } from 'primeng/dialog';
import { ProfileDto } from '../../dtos/response/profile.dto';
import { ProfileService } from '../../services/profile.service';
import { UserStatusDotComponent } from '../user-status-dot/user-status-dot.component';
import { TranslateModule } from '@ngx-translate/core';

@Component({
  selector: 'app-profile-dialog',
  standalone: true,
  imports: [Dialog, DatePipe, UserStatusDotComponent, TranslateModule],
  templateUrl: './profile-dialog.component.html',
  styleUrl: './profile-dialog.component.css',
})
export class ProfileDialogComponent implements OnChanges {
  @Input() userId: string | null = null;
  @Input() friendsSince: Date | null = null;
  @Input() bannerUrl: string | null = null;
  @Output() visibleChange = new EventEmitter<boolean>();

  private profileService = inject(ProfileService);

  protected dialogVisible = false;
  protected profile = signal<ProfileDto | undefined>(undefined);
  protected avatarExpanded = false;
  protected avatarError = signal(false);

  protected formattedHash = computed(() =>
    String(this.profile()?.hash ?? 0).padStart(4, '0')
  );

  protected avatarLabel = computed(() =>
    this.profile()?.userName?.[0]?.toUpperCase() ?? '?'
  );

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
