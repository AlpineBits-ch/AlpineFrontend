import { Injectable } from '@angular/core';
import { Channel, invoke, isTauri } from '@tauri-apps/api/core';

export interface ScreenSource {
  id: string;
  name: string;
  isMonitor: boolean;
  thumbnail: string; // base64 JPEG
  width: number;
  height: number;
}

export interface RustAudioSettings {
  deviceId: string | null;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  /** VAD gating threshold 0–1, 0 = disabled */
  vadThreshold: number;
}

interface AudioChunk {
  data: string;        // base64 f32-LE PCM
  sampleRate: number;
  channels: number;
}

interface ScreenFrame {
  data: string;        // base64 JPEG
  width: number;
  height: number;
  timestampMs: number;
}

@Injectable({ providedIn: 'root' })
export class RustMediaService {
  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private micDestination: MediaStreamAudioDestinationNode | null = null;
  private audioChannel: Channel<AudioChunk> | null = null;

  private screenCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  private screenCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
  private screenStream: MediaStream | null = null;
  private screenChannel: Channel<ScreenFrame> | null = null;

  // ── Screen sources ────────────────────────────────────────────────────────

  async getScreenSources(): Promise<ScreenSource[]> {
    if (!isTauri()) return [];
    try {
      return await invoke<ScreenSource[]>('enumerate_screen_sources');
    } catch (e) {
      console.warn('[RustMedia] enumerate_screen_sources failed', e);
      return [];
    }
  }

  // ── Screen capture ────────────────────────────────────────────────────────

  /**
   * Start Rust screen capture for the given source.
   * Returns a MediaStreamTrack backed by a canvas capture stream.
   */
  async startScreenCapture(sourceId: string, fps = 15): Promise<MediaStreamTrack> {
    await this.stopScreenCapture();

    // Create an off-screen canvas to receive frames
    const canvas = document.createElement('canvas');
    canvas.width  = 1920;
    canvas.height = 1080;
    const ctx = canvas.getContext('2d')!;
    this.screenCanvas = canvas;
    this.screenCtx    = ctx;

    const stream = (canvas as HTMLCanvasElement).captureStream(fps);
    this.screenStream = stream;

    const channel = new Channel<ScreenFrame>();
    this.screenChannel = channel;

    channel.onmessage = (frame) => {
      this.drawFrame(frame);
    };

    await invoke('start_screen_capture', { sourceId, fps, onFrame: channel });

    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('No video track from canvas');
    return track;
  }

  async stopScreenCapture(): Promise<void> {
    if (this.screenChannel) {
      this.screenChannel.onmessage = () => {};
      this.screenChannel = null;
    }
    if (isTauri()) {
      await invoke('stop_screen_capture').catch(() => {});
    }
    this.screenStream?.getTracks().forEach(t => t.stop());
    this.screenStream = null;
    this.screenCanvas = null;
    this.screenCtx    = null;
  }

  private drawFrame(frame: ScreenFrame): void {
    if (!this.screenCtx || !this.screenCanvas) return;
    const blob = base64ToBlob(frame.data, 'image/jpeg');
    createImageBitmap(blob).then(bitmap => {
      if (!this.screenCtx || !this.screenCanvas) { bitmap.close(); return; }
      const c = this.screenCanvas as HTMLCanvasElement;
      if (c.width !== bitmap.width || c.height !== bitmap.height) {
        c.width  = bitmap.width;
        c.height = bitmap.height;
      }
      (this.screenCtx as CanvasRenderingContext2D).drawImage(bitmap, 0, 0);
      bitmap.close();
    }).catch(() => {});
  }

  // ── Microphone capture ────────────────────────────────────────────────────

  /**
   * Start Rust microphone capture with audio processing.
   * Returns a MediaStreamTrack that can be added to an RTCPeerConnection.
   */
  async startMicCapture(settings: RustAudioSettings): Promise<MediaStreamTrack> {
    await this.stopMicCapture();

    const ctx = new AudioContext({ sampleRate: 48_000 });
    this.audioCtx = ctx;

    await ctx.audioWorklet.addModule('/assets/audio-capture-processor.js');

    const worklet = new AudioWorkletNode(ctx, 'audio-capture-processor', {
      numberOfInputs:  0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.workletNode = worklet;

    const destination = ctx.createMediaStreamDestination();
    this.micDestination = destination;
    worklet.connect(destination);

    const channel = new Channel<AudioChunk>();
    this.audioChannel = channel;

    channel.onmessage = (chunk) => {
      this.feedAudio(chunk);
    };

    await invoke('start_audio_capture', {
      settings: {
        deviceId: settings.deviceId,
        noiseSuppression: settings.noiseSuppression,
        autoGainControl: settings.autoGainControl,
        vadThreshold: settings.vadThreshold,
      },
      onChunk: channel,
    });

    const track = destination.stream.getAudioTracks()[0];
    if (!track) throw new Error('No audio track from worklet');
    return track;
  }

  async stopMicCapture(): Promise<void> {
    if (this.audioChannel) {
      this.audioChannel.onmessage = () => {};
      this.audioChannel = null;
    }
    if (isTauri()) {
      await invoke('stop_audio_capture').catch(() => {});
    }
    this.workletNode?.disconnect();
    this.workletNode = null;
    this.micDestination = null;
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
  }

  private feedAudio(chunk: AudioChunk): void {
    if (!this.workletNode) return;
    try {
      const raw = base64ToArrayBuffer(chunk.data);
      this.workletNode.port.postMessage({ type: 'samples', buffer: raw }, [raw]);
    } catch { /* ignore decode errors */ }
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin  = atob(b64);
  const buf  = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return buf;
}

function base64ToBlob(b64: string, mime: string): Blob {
  const bytes = base64ToArrayBuffer(b64);
  return new Blob([bytes], { type: mime });
}
