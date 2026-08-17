import {Component, inject} from '@angular/core';
import {DmSidepanelComponent} from '../dm-sidepanel/dm-sidepanel.component';
import {ChannelListComponent} from '../../../guild/components/channel-list/channel-list.component';
import {NavigationService} from '../../navigation.service';

@Component({
    selector: 'app-action-sidepanel',
    imports: [DmSidepanelComponent, ChannelListComponent],
    templateUrl: './action-sidepanel.component.html',
    styleUrl: './action-sidepanel.component.css',
})
export class ActionSidepanelComponent {
    protected navService = inject(NavigationService);
}
