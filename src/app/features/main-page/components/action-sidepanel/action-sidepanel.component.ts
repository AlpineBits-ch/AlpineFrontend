import { Component } from '@angular/core';
import {ServerTaskbarComponent} from "../server-taskbar/server-taskbar.component";
import {QuickSettingsComponent} from "../quick-settings/quick-settings.component";

@Component({
  selector: 'app-action-sidepanel',
  imports: [
    ServerTaskbarComponent,
    QuickSettingsComponent
  ],
  templateUrl: './action-sidepanel.component.html',
  styleUrl: './action-sidepanel.component.css',
})
export class ActionSidepanelComponent {

}
