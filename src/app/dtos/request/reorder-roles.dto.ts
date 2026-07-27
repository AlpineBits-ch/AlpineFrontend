export interface RolePositionDto {
    roleId: string;
    position: number;
}

export interface ReorderRolesDto {
    roles: RolePositionDto[];
}
