import {Component, input, output} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {EntitlementSubjectDto} from '../../../dtos/response/entitlement.dto';
import {VoiceLimitNotice} from '../../../services/voice-limits.service';

/**
 * What this room's plan is doing to this call, for as long as it is doing it.
 *
 * <p><b>This is not a toast.</b> "Your camera is off because this server is on the free plan" is the
 * state of the room and stays true until the plan or the room changes; announcing it for four
 * seconds and then removing it leaves a user with a dead camera button and no explanation anywhere
 * on screen. It was a toast, and that is the bug this component is.</p>
 *
 * <p>Three lines at most, and every one of them optional:</p>
 * <ul>
 *   <li>What was reduced, named - "sharing at 720p30". Absent for a key this build has no sentence
 *   for, which is a graceful fallback rather than a hole: the reason below still stands alone.</li>
 *   <li>Why, from the server's reason code. Never a raw code, and an unrecognised one renders the
 *   generic sentence rather than nothing.</li>
 *   <li>What to do about it - a <b>button</b> when the server said this caller can act, a
 *   <b>sentence</b> when somebody else can, and neither on an instance that sells nothing or against
 *   an operator ceiling no amount of money moves.</li>
 * </ul>
 *
 * <p><b>Nothing here computes any of that.</b> `remedy` and `actorCanRemedy` are server-computed -
 * the server resolves ManageGuild per request and knows whether the instance sells anything at all -
 * and re-deciding either here is how a client draws a buy button that answers `403`.</p>
 */
@Component({
    selector: 'app-voice-limit-notice',
    imports: [TranslateModule],
    templateUrl: './voice-limit-notice.component.html',
})
export class VoiceLimitNoticeComponent {
    readonly notices = input.required<VoiceLimitNotice[]>();

    /** The party the remedy applies to, so the caller can aim at the right guild or account. */
    upgrade = output<EntitlementSubjectDto | null>();
}
