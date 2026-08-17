import {HttpErrorResponse} from '@angular/common/http';
import {TestBed} from '@angular/core/testing';
import {of, throwError} from 'rxjs';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ComposerAttachmentsService} from './composer-attachments.service';
import {FileService} from '../../../../../services/file.service';
import {EntitlementStore} from '../../../../../stores/entitlement.store';

function fileOf(bytes: number, name = 'clip.mp4'): File {
    const file = new File(['x'], name, {type: 'video/mp4'});
    // A File built in the test environment cannot be given a size any other way, and the size is
    // the whole subject of the check under test.
    Object.defineProperty(file, 'size', {value: bytes});
    return file;
}

function setup(ceiling: number | null = null) {
    const uploadFile = vi.fn(() => of({id: 'attachment-1'}));
    const uploadCeilingBytes = vi.fn(() => ceiling);

    TestBed.configureTestingModule({
        providers: [
            ComposerAttachmentsService,
            {provide: FileService, useValue: {uploadFile}},
            {provide: EntitlementStore, useValue: {uploadCeilingBytes}},
        ],
    });

    return {service: TestBed.inject(ComposerAttachmentsService), uploadFile, uploadCeilingBytes};
}

beforeEach(() => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});

describe('the ceiling from the snapshot', () => {
    it('refuses a file the server would refuse, without spending the transfer on it', () => {
        const {service, uploadFile} = setup(8 * 1024 * 1024);

        service.attach(fileOf(200 * 1024 * 1024));

        expect(uploadFile).not.toHaveBeenCalled();
        expect(service.files()[0].uploadFailed).toBe(true);
        expect(service.files()[0].errorKey).toBe('COMPOSER.UPLOAD_TOO_LARGE');
    });

    it('uploads a file inside the ceiling', () => {
        const {service, uploadFile} = setup(8 * 1024 * 1024);

        service.attach(fileOf(1024));

        expect(uploadFile).toHaveBeenCalled();
        expect(service.files()[0].uploadedId).toBe('attachment-1');
    });

    /**
     * The client-side check is a courtesy rather than the enforcement: the ceiling can move between
     * the read and the transfer, and a set that has not loaded yet must not block anything.
     */
    it('lets everything through when no ceiling is held', () => {
        const {service, uploadFile} = setup(null);

        service.attach(fileOf(200 * 1024 * 1024));

        expect(uploadFile).toHaveBeenCalled();
    });

    /** A guild upload and a DM upload are capped by different keys. */
    it('asks about the scope the composer is writing into', () => {
        const {service, uploadCeilingBytes} = setup(null);
        service.guildId.set('guild-1');

        service.attach(fileOf(1024));

        expect(uploadCeilingBytes).toHaveBeenCalledWith('guild-1');
    });

    /** One oversized file in a batch is refused on its own. The rest still go. */
    it('refuses one file of a batch rather than the batch', () => {
        const {service, uploadFile} = setup(8 * 1024 * 1024);

        service.attach(fileOf(200 * 1024 * 1024, 'huge.mp4'));
        service.attach(fileOf(1024, 'small.mp4'));

        expect(uploadFile).toHaveBeenCalledTimes(1);
        expect(service.files().map(f => f.uploadFailed)).toEqual([true, false]);
    });
});

describe('a refusal from the server', () => {
    it('names an entitlement refusal', () => {
        const {service, uploadFile} = setup();
        uploadFile.mockReturnValue(
            throwError(
                () =>
                    new HttpErrorResponse({
                        status: 403,
                        error: {
                            code: 'user_plan_limit',
                            key: 'user.upload_max_bytes',
                            reason: 'user_plan_limit',
                            boundBy: 'user',
                            remedy: 'upgrade_user',
                            actorCanRemedy: true,
                            subject: {kind: 'user', id: 'user-1'},
                            retryable: false,
                        },
                    }),
            ),
        );

        service.attach(fileOf(1024));

        expect(service.failureKey()).toBe('ENTITLEMENT.REASON.USER_PLAN_LIMIT');
    });

    it('tells too-large from anything else', () => {
        const {service, uploadFile} = setup();
        uploadFile.mockReturnValue(throwError(() => new HttpErrorResponse({status: 413})));

        service.attach(fileOf(1024));

        expect(service.failureKey()).toBe('COMPOSER.UPLOAD_TOO_LARGE');
    });

    it('falls back to the generic sentence', () => {
        const {service, uploadFile} = setup();
        uploadFile.mockReturnValue(throwError(() => new HttpErrorResponse({status: 500})));

        service.attach(fileOf(1024));

        expect(service.hasFailed()).toBe(true);
        expect(service.failureKey()).toBe('COMPOSER.UPLOAD_FAILED');
    });

    it('says nothing when nothing failed', () => {
        const {service} = setup();

        service.attach(fileOf(1024));

        expect(service.hasFailed()).toBe(false);
        expect(service.failureKey()).toBeNull();
    });
});
