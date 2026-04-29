import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Avatar } from 'primeng/avatar';
import { CallStateService } from '../../../services/call-state.service';

@Component({
  selector: 'app-call-overlay',
  imports: [Avatar],
  templateUrl: './call-overlay.component.html',
  styleUrl: './call-overlay.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CallOverlayComponent {
  protected callState = inject(CallStateService);
}
