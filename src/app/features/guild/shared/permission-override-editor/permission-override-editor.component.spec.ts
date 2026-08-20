import {TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {EMPTY_OVERRIDE, PermissionOverrideEditorComponent} from './permission-override-editor.component';
import {EffectivePermissionsDto} from '../../../../dtos/response/effective-permissions.dto';
import {ChannelType} from '../../../../dtos/response/guild.dto';

function trace(sources: EffectivePermissionsDto['sources']): EffectivePermissionsDto {
    return {
        channelId: 'chan_1',
        subjectKind: 'Role',
        subjectId: 'role_1',
        permissions: 'None',
        modulePermissions: 'None',
        sources,
    };
}

function setup(
    options: {
        resolved?: EffectivePermissionsDto | null;
        override?: typeof EMPTY_OVERRIDE;
        saved?: typeof EMPTY_OVERRIDE;
    } = {},
) {
    TestBed.configureTestingModule({
        imports: [PermissionOverrideEditorComponent],
        providers: [provideTranslateService()],
    });

    const fixture = TestBed.createComponent(PermissionOverrideEditorComponent);
    fixture.componentRef.setInput('override', options.override ?? EMPTY_OVERRIDE);
    fixture.componentRef.setInput('savedOverride', options.saved ?? EMPTY_OVERRIDE);
    fixture.componentRef.setInput('resolved', options.resolved ?? null);
    fixture.componentRef.setInput('channelType', ChannelType.Text);
    fixture.detectChanges();

    return fixture.componentInstance;
}

describe('PermissionOverrideEditorComponent inherited values', () => {
    it('shows nothing until the trace arrives', () => {
        const component = setup();

        expect(component.inheritedState('SendMessages')).toBeNull();
    });

    it('reports the resolved value and the layer that decided it', () => {
        const component = setup({
            resolved: trace([{permission: 'SendMessages', granted: false, decidedBy: 'ChannelEveryoneDeny'}]),
        });

        expect(component.inheritedState('SendMessages')).toEqual({
            granted: false,
            decidedBy: 'ChannelEveryoneDeny',
        });
    });

    // The trace describes the saved state. A bit this subject overrides has no inherited value to
    // show, and a bit just cleared in the UI has one the trace cannot know yet.
    it('shows no ghost for a bit the saved override sets', () => {
        const component = setup({
            saved: {allow: 0n, deny: 2n, allowModule: 0n, denyModule: 0n}, // deny SendMessages
            override: EMPTY_OVERRIDE,
            resolved: trace([{permission: 'SendMessages', granted: false, decidedBy: 'ChannelRoleDeny'}]),
        });

        expect(component.inheritedState('SendMessages')).toBeNull();
    });

    it('names everything a deny takes with it', () => {
        const component = setup();

        const collateral = component.denyCollateral('SendMessages');

        expect(collateral).toContain('AttachFiles');
        expect(collateral).toContain('PinMessages');
        expect(collateral).not.toContain('SendMessages');
    });

    it('greys a row the current deny already removed', () => {
        const component = setup({
            override: {allow: 0n, deny: 1n, allowModule: 0n, denyModule: 0n}, // deny ViewChannel
        });

        expect(component.impliedOff('SendMessages')).toBe(true);
        expect(component.impliedOff('ManageEvents')).toBe(false);
    });
});
