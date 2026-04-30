import { Component, inject, OnDestroy, OnInit } from '@angular/core';
import { CallSessionService } from '../../../../../services/call-session.service';
import { SrcObjectDirective } from './src-object.directive';

@Component({
  selector: 'app-call-panel',
  templateUrl: './call-panel.component.html',
  styleUrl: './call-panel.component.css',
  imports: [SrcObjectDirective],
})
export class CallPanelComponent implements OnInit, OnDestroy {
  private callSession = inject(CallSessionService);

  protected session = this.callSession.session;
  protected duration = '00:00';
  private durationInterval?: ReturnType<typeof setInterval>;

  ngOnInit(): void {
    this.durationInterval = setInterval(() => {
      const s = this.callSession.session();
      if (!s) return;
      const elapsed = Math.floor((Date.now() - new Date(s.startedAt).getTime()) / 1000);
      const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
      const sec = (elapsed % 60).toString().padStart(2, '0');
      this.duration = `${m}:${sec}`;
    }, 1000);
  }

  ngOnDestroy(): void {
    clearInterval(this.durationInterval);
  }

  protected toggleMute():         void { this.callSession.toggleMute(); }
  protected toggleDeafen():       void { this.callSession.toggleDeafen(); }
  protected toggleCamera():       void { void this.callSession.toggleCamera(); }
  protected toggleScreenShare():  void { void this.callSession.toggleScreenShare(); }
  protected joinScreenShare(id: string): void { this.callSession.joinScreenShare(id); }
  protected endCall():            void { this.callSession.end(); }
}
