import * as fs from 'tns-core-modules/file-system';
import { layout } from 'tns-core-modules/ui/core/view';
import '../async-await';
import {
    AdvancedVideoViewBase,
    CameraPosition,
    Quality,
    saveToGalleryProperty,
    Orientation,
    outputOrientation,
    torchProperty,
} from './advanced-video-view.common';

export * from './advanced-video-view.common';

import { fromObject } from 'tns-core-modules/data/observable';

export enum NativeOrientation {
    Unknown,
    Portrait,
    PortraitUpsideDown,
    LandscapeLeft,
    LandscapeRight,
}

declare class AVCaptureFileOutputRecordingDelegateImplement extends NSObject implements AVCaptureFileOutputRecordingDelegate {
    static initWithOwner (
        owner: WeakRef<AdvancedVideoView>
    ): AVCaptureFileOutputRecordingDelegateImplement;
    private _owner: WeakRef<AdvancedVideoView>;

    captureOutputDidFinishRecordingToOutputFileAtURLFromConnectionsError(
        captureOutput: AVCaptureFileOutput,
        outputFileURL: NSURL,
        connections: NSArray<any>,
        error: NSError
    ): void;

    captureOutputDidStartRecordingToOutputFileAtURLFromConnections(
        captureOutput: AVCaptureFileOutput,
        fileURL: NSURL,
        connections: NSArray<any>
    ): void;
}

// Don't use class to solve some es6 targetting issues with TypeScript
// see https://github.com/NativeScript/ios-runtime/issues/818
const AVCaptureFileOutputRecordingDelegateImpl = (NSObject as any).extend({
    captureOutputDidFinishRecordingToOutputFileAtURLFromConnectionsError(
        captureOutput: AVCaptureFileOutput,
        outputFileURL: NSURL,
        connections: NSArray<any>,
        error: NSError
    ): void {
        const owner = this._owner.get();
        if (!owner) {
            return;
        }

        if (!error) {
            owner.notify({
                eventName: 'finished',
                object: fromObject({
                    file: outputFileURL.absoluteString
                })
            });
        } else {
            owner.notify({
                eventName: 'error',
                object: fromObject({
                    message: error.localizedDescription
                })
            });
        }

        owner.startPreview();
    },

    captureOutputDidStartRecordingToOutputFileAtURLFromConnections(
        captureOutput: AVCaptureFileOutput,
        fileURL: NSURL,
        connections: NSArray<any>
    ): void {
        const owner = this._owner.get();
        if (!owner) {
            return;
        }

        owner.notify({
            eventName: 'started',
            object: fromObject({})
        });
    },
}, {
    protocols: [AVCaptureFileOutputRecordingDelegate]
}) as typeof AVCaptureFileOutputRecordingDelegateImplement;

(AVCaptureFileOutputRecordingDelegateImpl as any).initWithOwner = function (
    owner: WeakRef<AdvancedVideoView>
): AVCaptureFileOutputRecordingDelegateImplement {
    let delegate = (AVCaptureFileOutputRecordingDelegateImpl as any).new() as
    AVCaptureFileOutputRecordingDelegateImplement;
    (delegate as any)._owner = owner;
    return delegate;
};

export class AdvancedVideoView extends AdvancedVideoViewBase {
    nativeView: UIView;
    _output: AVCaptureMovieFileOutput;
    _file: NSURL;
    _device: AVCaptureDevice;
    private session: AVCaptureSession;
    public thumbnails: string[];
    _fileName: string;
    private _delegate: AVCaptureFileOutputRecordingDelegateImplement;
    folder;

    private requestStoragePermission(): Promise<any> {
        return new Promise((resolve, reject) => {
            let authStatus = PHPhotoLibrary.authorizationStatus();
            if (authStatus === PHAuthorizationStatus.NotDetermined) {
                PHPhotoLibrary.requestAuthorization(auth => {
                    if (auth === PHAuthorizationStatus.Authorized) {
                        resolve();
                    }
                });
            } else if (authStatus !== PHAuthorizationStatus.Authorized) {
                reject();
            }
        });
    }

    public static isAvailable() {
        return UIImagePickerController.isSourceTypeAvailable(
            UIImagePickerControllerSourceType.Camera
        );
    }

    public createNativeView() {
        return UIView.new();
    }

    public initNativeView() {
        this._delegate = AVCaptureFileOutputRecordingDelegateImpl.initWithOwner(new WeakRef(this));
    }

    disposeNativeView() {
        this._delegate = null;
    }

    onLoaded() {
        super.onLoaded();
        this.startPreview();
    }

    onUnloaded() {
        this.stopPreview();
        super.onUnloaded();
    }

    get duration(): number {
        if (this._output && this._output.recordedDuration) {
            return Math.floor(
                Math.round(CMTimeGetSeconds(this._output.recordedDuration))
            );
        } else {
            return 0;
        }
    }

    [outputOrientation.getDefault](): Orientation {
        const connection = this._output.connectionWithMediaType(AVMediaTypeVideo);
        if (!connection) return Orientation.Unknown;
        return Orientation[NativeOrientation[connection.videoOrientation]];
    }

    [outputOrientation.setNative](orientation: Orientation) {
        this._setOutputOrientation(orientation);
    }

    [saveToGalleryProperty.getDefault]() {
        return false;
    }

    [saveToGalleryProperty.setNative](save: boolean) {
        return save;
    }

    [torchProperty.getDefault]() {
        return this._device && this._device.torchMode === AVCaptureTorchMode.On;
    }

    [torchProperty.setNative](torch) {
        if (!this.isTorchAvailable) return false;
        if (this._device.lockForConfiguration()) {
            if (torch) {
                this._device.setTorchModeOnWithLevelError(AVCaptureMaxAvailableTorchLevel);
            } else {
                this._device.torchMode = AVCaptureTorchMode.Off;
            }

            this._device.unlockForConfiguration();
        }
        return torch;
    }

    public get isTorchAvailable(): boolean {
        return this._device && this._device.hasTorch;
    }

    public toggleTorch() {
        if (!this.isTorchAvailable) return;
        this.torch = !this.torch;
    }

    private _setOutputOrientation(orientation: Orientation) {
        let nativeOrientation: number;
        switch (orientation) {
            case Orientation.LandscapeLeft:
                nativeOrientation = NativeOrientation.LandscapeLeft;
                break;
            case Orientation.LandscapeRight:
                nativeOrientation = NativeOrientation.LandscapeRight;
                break;
            case Orientation.Portrait:
                nativeOrientation = NativeOrientation.Portrait;
                break;
            case Orientation.PortraitUpsideDown:
                nativeOrientation = NativeOrientation.PortraitUpsideDown;
                break;
            default:
                nativeOrientation = NativeOrientation.Unknown;
                break;
        }

        const connection = this._output.connectionWithMediaType(AVMediaTypeVideo);
        if (
            connection &&
            connection.supportsVideoOrientation &&
            nativeOrientation !== NativeOrientation.Unknown
        ) {
            connection.videoOrientation = nativeOrientation;
        }
    }

    private openCamera(): void {
        try {

            this.session = new AVCaptureSession();
            let devices = AVCaptureDevice.devicesWithMediaType(AVMediaTypeVideo);
            let pos =
                this.cameraPosition === 'front'
                    ? AVCaptureDevicePosition.Front
                    : AVCaptureDevicePosition.Back;
            for (let i = 0; i < devices.count; i++) {
                if (devices[i].position === pos) {
                    this._device = devices[i];
                    break;
                }
            }

            let input: AVCaptureDeviceInput = AVCaptureDeviceInput
                .deviceInputWithDeviceError(this._device);
            let audioDevice: AVCaptureDevice = AVCaptureDevice.defaultDeviceWithMediaType(
                AVMediaTypeAudio
            );
            let audioInput: AVCaptureDeviceInput =
                AVCaptureDeviceInput
                    .deviceInputWithDeviceError(audioDevice);

            this._output = AVCaptureMovieFileOutput.alloc().init();
            this._output.movieFragmentInterval = kCMTimeInvalid;
            const connection =  this._output.connectionWithMediaType(AVMediaTypeVideo);

            if (this._output.availableVideoCodecTypes.containsObject(AVVideoCodecTypeH264)) {
                const codec = {};
                codec[AVVideoCodecKey] = AVVideoCodecTypeH264;
                this._output.setOutputSettingsForConnection(<any>codec, connection);
            }
            let format = '.mp4'; // options && options.format === 'default' ? '.mov' : '.' + options.format;
            this._fileName = `VID_${+new Date()}${format}`;
            this.folder = fs.knownFolders.temp().getFolder(Date.now().toString());
            let path = fs.path.join(this.folder.path, this._fileName);
            this._file = NSURL.fileURLWithPath(path);

            if (!input) {
                this.notify({
                    eventName: 'error',
                    object: fromObject({
                        message: 'Error trying to open camera.'
                    })
                });
            }

            if (!audioInput) {
                this.notify({
                    eventName: 'error',
                    object: fromObject({
                        message: 'Error trying to open mic.'
                    })
                });
            }

            // this._output.maxRecordedDuration =
            //   types.isNumber(options.duration) && options.duration > 0
            //     ? CMTimeMakeWithSeconds(options.duration, 1)
            //     : kCMTimePositiveInfinity;

            // if (options.size > 0) {
            //   this._output.maxRecordedFileSize = options.size * 1024 * 1024;
            // }

            this.session.beginConfiguration();

            switch (this.quality) {
                case Quality.MAX_720P:
                    this.session.sessionPreset = AVCaptureSessionPreset1280x720;
                    break;
                case Quality.MAX_1080P:
                    this.session.sessionPreset = AVCaptureSessionPreset1920x1080;
                    break;
                case Quality.MAX_2160P:
                    this.session.sessionPreset = AVCaptureSessionPreset3840x2160;
                    break;
                case Quality.HIGHEST:
                    this.session.sessionPreset = AVCaptureSessionPresetHigh;
                    break;
                case Quality.LOWEST:
                    this.session.sessionPreset = AVCaptureSessionPresetLow;
                    break;
                case Quality.QVGA:
                    this.session.sessionPreset = AVCaptureSessionPreset352x288;
                    break;
                default:
                    this.session.sessionPreset = AVCaptureSessionPreset640x480;
                    break;
            }

            this.session.addInput(input);

            this.session.addInput(audioInput);

            this.session.addOutput(this._output);

            this.session.commitConfiguration();

            let preview = AVCaptureVideoPreviewLayer.alloc().initWithSession(
                this.session
            );
            dispatch_async(dispatch_get_current_queue(), () => {
                preview.videoGravity = this.fill ? AVLayerVideoGravityResizeAspectFill : AVLayerVideoGravityResizeAspect;
            });
            if (!this.session.running) {
                this.session.startRunning();
            }

            dispatch_async(dispatch_get_current_queue(), () => {
                this._setOutputOrientation(this.outputOrientation);

                preview.frame = this.nativeView.bounds;
                this.nativeView.layer.addSublayer(preview);
            });
        } catch (ex) {
            let msg = 'unknown';

            if (typeof ex.getMessage === 'function') {
                msg = ex.getMessage();
            } else if (ex.localizedDescription) {
                msg = ex.localizedDescription;
            }
            console.log(msg);
            this.notify({
                eventName: 'error',
                object: fromObject({
                    message: msg
                })
            });
        }
    }

    public startRecording(): void {
        this._output.startRecordingToOutputFileURLRecordingDelegate(
            this._file,
            this._delegate
        );
    }

    public stopRecording(): void {
        this.session.stopRunning();
        if (this.thumbnailCount && this.thumbnailCount > 0) {
            this.extractThumbnails();
        }
    }

    public stopPreview(): void {
        if (this.session.running) {
            this.session.stopRunning();
        }
    }

    public toggleCamera(): void {
        if (this.cameraPosition === CameraPosition.BACK.toString()) {
            this.cameraPosition = 'front';
        } else {
            this.cameraPosition = 'back';
        }
        this.stopPreview();
        this.startPreview();
    }

    public startPreview(): void {
        this.openCamera();
    }

    public onLayout(left: number, top: number, right: number, bottom: number) {
        if (this.nativeView.layer && this.nativeView.layer.sublayers && this.nativeView.layer.sublayers[0]) {
            dispatch_async(dispatch_get_current_queue(), () => {
                this.nativeView.layer.sublayers[0].frame = this.nativeView.bounds;
            });
        }
    }

    public onMeasure(widthMeasureSpec: number, heightMeasureSpec: number) {
        const width = layout.getMeasureSpecSize(widthMeasureSpec);
        const height = layout.getMeasureSpecSize(heightMeasureSpec);
        this.setMeasuredDimension(width, height);
    }

    private extractThumbnails() {
        this.thumbnails = [];
        let asset = AVURLAsset.alloc().initWithURLOptions(
            this._file,
            null
        );
        let assetIG = AVAssetImageGenerator.alloc().initWithAsset(asset);
        assetIG.appliesPreferredTrackTransform = true;
        assetIG.apertureMode = AVAssetImageGeneratorApertureModeEncodedPixels;
        let it = parseInt((asset.duration.value / this.thumbnailCount).toString());

        for (let index = 0; index < this.thumbnailCount; index++) {
            let thumbnailImageRef = assetIG.copyCGImageAtTimeActualTimeError(
                CMTimeMake(it * index, asset.duration.timescale),
                null
            );

            if (!thumbnailImageRef) {
                console.log("Thumbnail Image Generation Error");
            }

            let image = UIImage.alloc().initWithCGImage(thumbnailImageRef);


            let outputFilePath =
                this._fileName.substr(0, this._fileName.lastIndexOf(".")) +
                "_thumb_" +
                index +
                ".png";

            let path = fs.path.join(this.folder.path, outputFilePath);
            let ok = UIImagePNGRepresentation(image).writeToFileAtomically(
                path,
                true
            );

            if (!ok) {
                console.log("Could not write thumbnail to file");
            } else {
                this.thumbnails.push(path);
            }
        }
    }
}
