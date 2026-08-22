import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {of} from 'rxjs';
import {TranslateModule} from '@ngx-translate/core';
import {FirstRunComponent} from './first-run.component';
import {FirstRunService} from '../../services/first-run.service';
import {FirstRunStep} from '../../services/first-run-steps';
import {OnboardingService} from '../../services/onboarding.service';
import {MasterKeySetupService} from '../../services/master-key-setup.service';
import {DeviceRegistrationService} from '../../services/device-registration.service';
import {SignupPasswordHolder} from '../../services/signup-password-holder';
import {OsInfo} from '../../platform/ports/os-info.port';

const CODE = 'anchor breeze cinder dapple ember fathom';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return {promise, resolve, reject};
}

function setup(steps: FirstRunStep[], options: {submitFails?: boolean} = {}) {
    // The demanded word is picked at random; pinning it makes the confirm typeable from a test.
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const complete = vi.fn();
    const submit = vi.fn(async () =>
        options.submitFails ? Promise.reject(new Error('nope')) : Promise.resolve(),
    );
    const register = vi.fn(() => of('handle'));
    const generateRecoveryCode = vi.fn(async () => CODE);
    const write = deferred<{version: number}>();
    const run = vi.fn(() => write.promise);
    const verifyPassword = vi.fn(async () => true);

    TestBed.configureTestingModule({
        imports: [FirstRunComponent, TranslateModule.forRoot()],
        providers: [
            {
                provide: FirstRunService,
                useValue: {visible: signal(true), steps: signal(steps), complete},
            },
            {
                provide: OnboardingService,
                useValue: {submit, wantsSocial: signal(true)},
            },
            {
                provide: MasterKeySetupService,
                useValue: {
                    verifyPassword,
                    generateRecoveryCode,
                    run,
                    discard: vi.fn(),
                    // The real one. It reads no `this`, and which branch it picks is under test.
                    describeFailure: MasterKeySetupService.prototype.describeFailure,
                },
            },
            {provide: DeviceRegistrationService, useValue: {register}},
            {provide: SignupPasswordHolder, useValue: {has: () => true, take: () => 'hunter2'}},
            {
                provide: OsInfo,
                useValue: {
                    kind: 'windows',
                    isMobile: false,
                    appName: async () => 'Venta',
                    appVersion: async () => '1.0.0',
                    hostname: async () => 'workshop-pc',
                },
            },
        ],
    });

    const fixture = TestBed.createComponent(FirstRunComponent);
    fixture.detectChanges();

    return {fixture, complete, submit, register, generateRecoveryCode, run, write, verifyPassword};
}

async function settle(fixture: ComponentFixture<FirstRunComponent>): Promise<void> {
    for (let i = 0; i < 4; i++) {
        await fixture.whenStable();
        fixture.detectChanges();
    }
}

function continueButton(fixture: ComponentFixture<FirstRunComponent>): HTMLButtonElement {
    const button = fixture.nativeElement.querySelector('[data-testid="first-run-continue"] button');
    expect(button).toBeTruthy();
    return button as HTMLButtonElement;
}

function text(fixture: ComponentFixture<FirstRunComponent>, testid: string): string {
    const el = fixture.nativeElement.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
    return el?.textContent?.trim() ?? '';
}

function typeConfirmWord(fixture: ComponentFixture<FirstRunComponent>, word: string): void {
    const input = fixture.nativeElement.querySelector(
        '[data-testid="first-run-confirm-input"]',
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    input.value = word;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
}

describe('FirstRunComponent device registration', () => {
    it('registers this device before the pick has been answered', async () => {
        const {fixture, register, submit} = setup(['pick', 'recovery-code']);

        await settle(fixture);

        expect(register).toHaveBeenCalledWith('workshop-pc');
        expect(submit).not.toHaveBeenCalled();
    });
});

describe('FirstRunComponent pick step', () => {
    it('leaves the takeover open and says so when the answer will not save', async () => {
        const {fixture, complete, submit} = setup(['pick'], {submitFails: true});
        await settle(fixture);

        (
            fixture.nativeElement.querySelectorAll('[data-testid="onboarding-choice"]')[1] as HTMLElement
        ).click();
        fixture.detectChanges();
        continueButton(fixture).click();
        await settle(fixture);

        expect(submit).toHaveBeenCalled();
        expect(complete).not.toHaveBeenCalled();
        expect(text(fixture, 'first-run-submit-error')).toContain('ACCOUNT_ONBOARDING.SUBMIT_ERROR');
    });
});

describe('FirstRunComponent recovery-code step', () => {
    it('does not mint a second code when a failed write is retried', async () => {
        const {fixture, generateRecoveryCode, run, write} = setup(['recovery-code']);
        await settle(fixture);

        write.reject(new Error('server said no'));
        await settle(fixture);

        expect(text(fixture, 'first-run-error')).toContain('FIRST_RUN.CODE.SETUP_FAILED');

        continueButton(fixture).click();
        await settle(fixture);

        // The user has already written this code down. Minting another silently loses it.
        expect(generateRecoveryCode).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledTimes(2);
        expect(text(fixture, 'first-run-code-value')).toBe(CODE);
    });

    /**
     * A hard, permanent, every-account refusal read as a flaky network for as long as this was one
     * sentence. The lead stays, the server's reason goes after it.
     */
    it('says what the server refused, under the line telling the user the code still works', async () => {
        const {fixture, write} = setup(['recovery-code']);
        await settle(fixture);

        write.reject(new HttpErrorResponse({status: 400, error: {detail: 'publicVerifier is required'}}));
        await settle(fixture);

        expect(text(fixture, 'first-run-error')).toBe(
            'FIRST_RUN.CODE.SETUP_FAILED The server refused the setup: publicVerifier is required',
        );
    });

    it('adds nothing when the failure has nothing of its own to say', async () => {
        const {fixture, write} = setup(['recovery-code']);
        await settle(fixture);

        write.reject(new Error('socket hang up'));
        await settle(fixture);

        expect(text(fixture, 'first-run-error')).toBe('FIRST_RUN.CODE.SETUP_FAILED');
    });

    it('does not advance on a finished write alone', async () => {
        const {fixture, complete, write} = setup(['recovery-code']);
        await settle(fixture);

        write.resolve({version: 1});
        await settle(fixture);

        expect(continueButton(fixture).disabled).toBe(true);
        continueButton(fixture).click();
        await settle(fixture);

        expect(complete).not.toHaveBeenCalled();
    });

    it('does not advance on the confirmed word alone', async () => {
        const {fixture, complete} = setup(['recovery-code']);
        await settle(fixture);

        typeConfirmWord(fixture, 'anchor');
        await settle(fixture);

        expect(continueButton(fixture).disabled).toBe(true);
        expect(complete).not.toHaveBeenCalled();
    });

    it('advances once the word is confirmed and the write has landed', async () => {
        const {fixture, complete, write} = setup(['recovery-code']);
        await settle(fixture);

        typeConfirmWord(fixture, 'anchor');
        write.resolve({version: 1});
        await settle(fixture);

        continueButton(fixture).click();
        await settle(fixture);

        expect(complete).toHaveBeenCalled();
    });
});
