import {ChangeDetectionStrategy, Component} from '@angular/core';

@Component({
    selector: 'app-member',
    imports: [],
    templateUrl: './member.component.html',
    styleUrl: './member.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MemberComponent {}
