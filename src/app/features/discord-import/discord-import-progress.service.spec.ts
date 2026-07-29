import {TestBed} from '@angular/core/testing';
import {Router} from '@angular/router';
import {provideTranslateService} from '@ngx-translate/core';
import {DiscordImportProgressService} from './discord-import-progress.service';
import {AuthService} from '../../services/auth.service';
import {ToastService} from '../../services/toast.service';

function setup(isLoggedIn: boolean) {
    const authService = {isLoggedIn: vi.fn(() => Promise.resolve(isLoggedIn))};
    const router = {navigate: vi.fn()};
    const toastService = {error: vi.fn()};

    TestBed.configureTestingModule({
        providers: [
            provideTranslateService({defaultLanguage: 'en'}),
            {provide: AuthService, useValue: authService},
            {provide: Router, useValue: router},
            {provide: ToastService, useValue: toastService},
        ],
    });

    return {
        service: TestBed.inject(DiscordImportProgressService),
        authService,
        router,
        toastService,
    };
}

describe('DiscordImportProgressService.requestOpen', () => {
    it('sets request() directly when the user is logged in', async () => {
        const {service} = setup(true);
        await service.requestOpen({jobId: 'job1'});
        expect(service.request()).toEqual({jobId: 'job1'});
    });

    it('navigates to /authentication and stashes the jobId when logged out', async () => {
        const {service, router} = setup(false);
        await service.requestOpen({jobId: 'job1'});
        expect(router.navigate).toHaveBeenCalledWith(['/authentication']);
        expect(service.request()).toBeNull();
    });

    it('shows a toast and does not set request() when params carry an error', async () => {
        const {service, toastService} = setup(true);
        await service.requestOpen({error: 'access_denied'});
        expect(toastService.error).toHaveBeenCalled();
        expect(service.request()).toBeNull();
    });

    it('is a no-op when params carry neither jobId nor error', async () => {
        const {service} = setup(true);
        await service.requestOpen({});
        expect(service.request()).toBeNull();
    });
});

describe('DiscordImportProgressService.resumeIfPending', () => {
    it('opens the stashed jobId after a logged-out requestOpen', async () => {
        const {service} = setup(false);
        await service.requestOpen({jobId: 'job1'});
        service.resumeIfPending();
        expect(service.request()).toEqual({jobId: 'job1'});
    });

    it('is a no-op the second time (stash drained)', async () => {
        const {service} = setup(false);
        await service.requestOpen({jobId: 'job1'});
        service.resumeIfPending();
        service.close();
        service.resumeIfPending();
        expect(service.request()).toBeNull();
    });
});

describe('DiscordImportProgressService.close', () => {
    it('clears request()', async () => {
        const {service} = setup(true);
        await service.requestOpen({jobId: 'job1'});
        service.close();
        expect(service.request()).toBeNull();
    });
});
