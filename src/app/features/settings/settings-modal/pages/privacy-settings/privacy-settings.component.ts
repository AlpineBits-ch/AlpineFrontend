import {Component} from '@angular/core';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {RadioButton} from 'primeng/radiobutton';
import {FormsModule} from '@angular/forms';
import {TranslateModule} from '@ngx-translate/core';

@Component({
    selector: 'app-privacy-settings',
    imports: [ToggleSwitch, RadioButton, FormsModule, TranslateModule],
    templateUrl: './privacy-settings.component.html',
    styleUrl: './privacy-settings.component.css',
})
export class PrivacySettingsComponent {
    selectedFriendRequest = 'everyone';

    public readonly friendRequestOptions = [
        {label: 'Everyone', desc: 'Anyone on Alpine can send you a request.', value: 'everyone'},
        {label: 'Friends of Friends', desc: 'Only people who share a mutual friend.', value: 'friends'},
        {label: 'Nobody', desc: 'Disable all incoming friend requests.', value: 'nobody'},
    ];

    public readonly dmToggles = [
        {label: 'Allow DMs from friends', desc: 'Friends can send you direct messages.'},
        {label: 'Allow DMs from server members', desc: 'People in shared servers can message you.'},
    ];

    public readonly presenceToggles = [
        {label: 'Show online status', desc: 'Let others see when you are active.'},
        {label: 'Show current activity', desc: 'Display what you are playing or working on.'},
    ];
}
