import { Component, inject, Input, OnChanges, Output, EventEmitter, signal, computed, SimpleChanges } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Dialog } from 'primeng/dialog';
import { ProfileDto } from '../../dtos/response/profile.dto';
import { ProfileService } from '../../services/profile.service';
import { UserStatusDotComponent } from '../user-status-dot/user-status-dot.component';

@Component({
  selector: 'app-profile-dialog',
  standalone: true,
  imports: [Dialog, DatePipe, UserStatusDotComponent],
  templateUrl: './profile-dialog.component.html',
  styleUrl: './profile-dialog.component.css',
})
export class ProfileDialogComponent implements OnChanges {
  @Input() userId: string | null = null;
  @Input() friendsSince: Date | null = null;
  @Input() bannerUrl: string | null = null;
  @Input() visible = false;
  @Output() visibleChange = new EventEmitter<boolean>();

  private profileService = inject(ProfileService);

  protected profile = signal<ProfileDto | undefined>(undefined);
  protected avatarExpanded = false;

  protected formattedHash = computed(() =>
    String(this.profile()?.hash ?? 0).padStart(4, '0')
  );

  protected avatarLabel = computed(() =>
    this.profile()?.userName?.[0]?.toUpperCase() ?? '?'
  );

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['userId']) {
      const id = this.userId;
      if (!id) {
        this.profile.set(undefined);
        this.avatarExpanded = false;
        return;
      }
      const cached = this.profileService.getCachedByUserId(id);
      if (cached) {
        this.profile.set(cached);
      } else {
        this.profile.set(undefined);
        this.profileService.getByUserId(id).subscribe(p => this.profile.set(p));
      }
    }
  }

  protected close(): void {
    this.visibleChange.emit(false);
  }

  protected onAvatarClick(): void {
    if (this.profile()?.avatarUrl) {
      this.avatarExpanded = true;
    }
  }
}
