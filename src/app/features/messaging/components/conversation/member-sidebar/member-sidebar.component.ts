import {ChangeDetectionStrategy, Component} from '@angular/core';

@Component({
    selector: 'app-member-sidebar',
    imports: [],
    templateUrl: './member-sidebar.component.html',
    styleUrl: './member-sidebar.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MemberSidebarComponent {}
