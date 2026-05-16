import { Component, computed, inject, input, output, signal } from '@angular/core';
import { NgClass } from '@angular/common';
import { VoiceChannelParticipant, VoiceChannelService } from '../../../../services/voice-channel.service';
import { RustMediaService } from '../../../../services/rust-media.service';
import { AppAvatarComponent } from '../../../../components/avatar/avatar.component';
import { StreamSrcDirective } from '../../../../directives/stream-src.directive';

export interface ScreenLayoutContextMenuEvent {
  event: MouseEvent;
  participant: VoiceChannelParticipant;
}

@Component({
  selector: 'app-voice-channel-screen-layout',
  imports: [NgClass, AppAvatarComponent, StreamSrcDirective],
  templateUrl: './voice-channel-screen-layout.component.html',
})
export class VoiceChannelScreenLayoutComponent {
  protected voiceSvc  = inject(VoiceChannelService);
  protected rustMedia = inject(RustMediaService);

  screenSharers = input.required<VoiceChannelParticipant[]>();
  participants  = input.required<VoiceChannelParticipant[]>();

  participantContextMenu = output<ScreenLayoutContextMenuEvent>();

  protected readonly maximizedId = signal<string | null>(null);
  private readonly _zoom = signal<Record<string, number>>({});

  protected displayedSharers = computed(() => {
    const id = this.maximizedId();
    return id === null ? this.screenSharers() : this.screenSharers().filter(s => s.userId === id);
  });

  protected gridClass = computed(() =>
    this.maximizedId() === null && this.screenSharers().length > 1 ? 'grid-cols-2' : 'grid-cols-1'
  );

  protected getZoom(userId: string): number {
    return this._zoom()[userId] ?? 1;
  }

  protected zoomIn(userId: string, event: MouseEvent): void {
    event.stopPropagation();
    const cur = this.getZoom(userId);
    if (cur < 3) this._zoom.update(z => ({ ...z, [userId]: +(cur + 0.25).toFixed(2) }));
  }

  protected zoomOut(userId: string, event: MouseEvent): void {
    event.stopPropagation();
    const cur = this.getZoom(userId);
    if (cur > 1) this._zoom.update(z => ({ ...z, [userId]: Math.max(1, +(cur - 0.25).toFixed(2)) }));
  }

  protected toggleMaximize(userId: string, event: MouseEvent): void {
    event.stopPropagation();
    this.maximizedId.update(id => id === userId ? null : userId);
  }

  protected pipShare(event: MouseEvent): void {
    event.stopPropagation();
    const tile = (event.currentTarget as HTMLElement).closest('.relative') as HTMLElement | null;
    const video = tile?.querySelector('video') as HTMLVideoElement | null;
    if (!video || !document.pictureInPictureEnabled) return;
    if (document.pictureInPictureElement === video) {
      document.exitPictureInPicture().catch(() => {});
    } else {
      video.requestPictureInPicture().catch(() => {});
    }
  }
}
