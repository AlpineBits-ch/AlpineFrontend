import {inject, Injectable} from '@angular/core';
import {Observable} from 'rxjs';
import {ChannelPermission} from '../../../../dtos/response/guild.dto';
import {GuildService, OverridePermissionsDto} from '../../../../services/guild.service';
import {PermissionScope} from './permission-scope';

export interface OverrideTarget {
    kind: 'role' | 'member';
    id: string;
}

/** The four write calls, picked by scope and target instead of by having two copies of the page. */
@Injectable({providedIn: 'root'})
export class PermissionScopeGateway {
    private guildService = inject(GuildService);

    upsert(
        scope: PermissionScope,
        target: OverrideTarget,
        dto: OverridePermissionsDto,
    ): Observable<ChannelPermission> {
        if (scope.kind === 'channel') {
            return target.kind === 'role'
                ? this.guildService.upsertChannelRolePermission(scope.id, target.id, dto)
                : this.guildService.upsertChannelMemberPermission(scope.id, target.id, dto);
        }

        return target.kind === 'role'
            ? this.guildService.upsertCategoryRolePermission(scope.id, target.id, dto)
            : this.guildService.upsertCategoryMemberPermission(scope.id, target.id, dto);
    }

    remove(scope: PermissionScope, target: OverrideTarget): Observable<void> {
        if (scope.kind === 'channel') {
            return target.kind === 'role'
                ? this.guildService.deleteChannelRolePermission(scope.id, target.id)
                : this.guildService.deleteChannelMemberPermission(scope.id, target.id);
        }

        return target.kind === 'role'
            ? this.guildService.deleteCategoryRolePermission(scope.id, target.id)
            : this.guildService.deleteCategoryMemberPermission(scope.id, target.id);
    }
}
