import {ChangeDetectionStrategy, Component, computed, inject, input, model, signal} from '@angular/core';
import {toObservable, toSignal} from '@angular/core/rxjs-interop';
import {catchError, debounceTime, map, of, switchMap} from 'rxjs';
import {FormsModule} from '@angular/forms';
import {Dialog} from 'primeng/dialog';
import {InputText} from 'primeng/inputtext';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule} from '@ngx-translate/core';
import {AppAvatarComponent} from '../../../components/avatar/avatar.component';
import {GuildDto, RoleDto} from '../../../dtos/response/guild.dto';
import {GuildMemberDto} from '../../../dtos/response/member.dto';
import {GuildService} from '../../../services/guild.service';
import {ViewAsService} from './view-as.service';

/** Long enough that a typed word is one request, short enough it still feels live. */
const MEMBER_SEARCH_DEBOUNCE_MS = 250;

/** One row for the member half of the picker. Flattened so the template never reaches into a profile. */
interface MemberCandidate {
    id: string;
    userId: string;
    name: string;
}

@Component({
    selector: 'app-view-as-picker',
    imports: [Dialog, InputText, PrimeTemplate, FormsModule, TranslateModule, AppAvatarComponent],
    templateUrl: './view-as-picker.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ViewAsPickerComponent {
    readonly visible = model.required<boolean>();
    readonly guild = input.required<GuildDto>();

    protected readonly roles = computed(() =>
        [...this.guild().roles].sort((a, b) => b.position - a.position),
    );

    protected readonly memberQuery = signal('');

    private readonly guildService = inject(GuildService);
    private readonly viewAs = inject(ViewAsService);

    protected readonly memberCandidates = toSignal(
        toObservable(this.memberQuery).pipe(
            debounceTime(MEMBER_SEARCH_DEBOUNCE_MS),
            switchMap(term => {
                if (!term.trim()) return of<GuildMemberDto[]>([]);
                return this.guildService
                    .searchMembers(this.guild().id, term)
                    .pipe(catchError(() => of<GuildMemberDto[]>([])));
            }),
            map(members => members.map(ViewAsPickerComponent.toCandidate)),
        ),
        {initialValue: [] as MemberCandidate[]},
    );

    protected pickRole(role: RoleDto): void {
        this.viewAs.enter(this.guild().id, {kind: 'role', id: role.id, name: role.name, color: role.color});
        this.close();
    }

    protected pickMember(candidate: MemberCandidate): void {
        this.viewAs.enter(this.guild().id, {kind: 'member', id: candidate.id, name: candidate.name});
        this.close();
    }

    protected close(): void {
        this.visible.set(false);
        this.memberQuery.set('');
    }

    private static toCandidate(member: GuildMemberDto): MemberCandidate {
        return {
            id: member.id,
            userId: member.userId,
            name: member.nickname || member.profile?.userName || member.userId,
        };
    }
}
