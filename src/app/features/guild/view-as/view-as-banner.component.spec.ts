import {ComponentFixture, TestBed} from '@angular/core/testing';
import {of} from 'rxjs';
import {vi} from 'vitest';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {ViewAsBannerComponent} from './view-as-banner.component';
import {ViewAsService} from './view-as.service';
import {GuildService} from '../../../services/guild.service';
import {EffectivePermissionsDto} from '../../../dtos/response/effective-permissions.dto';

// The locales submodule carries these keys under a separate commit; the two used here are set
// directly so the test does not depend on that landing first.
const TRANSLATIONS = {
    VIEW_AS: {
        BANNER: 'Viewing as {{name}}. {{visible}} of {{total}} channels visible.',
        EXIT: 'Exit',
    },
};

function setup(): {
    fixture: ComponentFixture<ViewAsBannerComponent>;
    service: ViewAsService;
    component: ViewAsBannerComponent;
} {
    const guildService = {
        getEffectivePermissions: vi.fn(() =>
            of({
                channelId: 'chan_1',
                subjectKind: 'Role',
                subjectId: 'role_1',
                permissions: 'None',
                modulePermissions: 'None',
                sources: [],
            } satisfies EffectivePermissionsDto),
        ),
    };

    TestBed.configureTestingModule({
        imports: [ViewAsBannerComponent, TranslateModule.forRoot()],
        providers: [ViewAsService, {provide: GuildService, useValue: guildService}],
    });

    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', TRANSLATIONS);
    translate.use('en');

    const fixture = TestBed.createComponent(ViewAsBannerComponent);
    fixture.componentRef.setInput('guildId', 'guild_1');
    const service = TestBed.inject(ViewAsService);
    fixture.detectChanges();

    return {fixture, service, component: fixture.componentInstance};
}

describe('ViewAsBannerComponent', () => {
    it('draws nothing when the mode is off', () => {
        const {fixture} = setup();

        expect(fixture.nativeElement.textContent.trim()).toBe('');
    });

    it('names the subject and counts what they can see', () => {
        const {fixture, service} = setup();
        service.enter('guild_1', {kind: 'role', id: 'role_1', name: 'Recruit'});
        fixture.componentRef.setInput('visibleCount', 9);
        fixture.componentRef.setInput('totalCount', 14);
        fixture.detectChanges();

        expect(fixture.nativeElement.textContent).toContain('Recruit');
        expect(fixture.nativeElement.textContent).toContain('9');
        expect(fixture.nativeElement.textContent).toContain('14');
    });

    it('exits the mode when asked', () => {
        const {fixture, service, component} = setup();
        service.enter('guild_1', {kind: 'role', id: 'role_1', name: 'Recruit'});
        fixture.detectChanges();

        component.exit();

        expect(service.active('guild_1')()).toBe(false);
    });
});
