import {ChangeDetectionStrategy, Component, computed, inject} from '@angular/core';
import {Avatar} from 'primeng/avatar';
import {CallStateService} from '../../../services/call-state.service';
import {NavigationService} from '../../main-page/navigation.service';
import {TranslateModule} from '@ngx-translate/core';

@Component({
    selector: 'app-call-overlay',
    imports: [Avatar, TranslateModule],
    templateUrl: './call-overlay.component.html',
    styleUrl: './call-overlay.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CallOverlayComponent {
    protected callState = inject(CallStateService);
    private navService = inject(NavigationService);

    // Hide the floating "Calling..." card while the matching conversation is
    // already open - the conversation's own ringing banner covers that case,
    // and showing both was a confusing double indicator.
    protected readonly showOutgoingCard = computed(() => {
        const out = this.callState.outgoingCall();
        if (!out) return false;
        const view = this.navService.mainView();
        return !(view.type === 'conversation' && view.conversation.id === out.conversationId);
    });
}
