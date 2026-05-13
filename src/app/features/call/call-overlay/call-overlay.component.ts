import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Avatar } from 'primeng/avatar';
import { CallStateService } from '../../../services/call-state.service';
import { TranslateModule } from '@ngx-translate/core';

@Component({
  selector: 'app-call-overlay',
  imports: [Avatar, TranslateModule],
  templateUrl: './call-overlay.component.html',
  styleUrl: './call-overlay.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CallOverlayComponent {
  protected callState = inject(CallStateService);
}
