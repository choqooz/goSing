import { describe, expect, it, vi } from "vitest";
import {
  createDualAudioController,
  type AudioTrack,
  type DualAudioCallbacks,
} from "@/player/dual-audio-controller";

class FakeAudioTrack implements AudioTrack {
  currentTime = 0;
  duration = 180;
  volume = 1;
  pause = vi.fn();
  play = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
}

function createCallbacks() {
  const callbacks: DualAudioCallbacks = {
    onCurrentTimeChange: vi.fn(),
    onDurationChange: vi.fn(),
    onIsPlayingChange: vi.fn(),
    onMasterTimeUpdate: vi.fn(),
    onPlaybackError: vi.fn(),
  };
  return callbacks;
}

function deferred() {
  let resolve: () => void;
  let reject: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject: reject!, resolve: resolve! };
}

describe("dual audio controller", () => {
  it("starts both tracks before reporting playback", async () => {
    const instrumental = new FakeAudioTrack();
    const vocal = new FakeAudioTrack();
    const callbacks = createCallbacks();

    const started = await createDualAudioController(instrumental, vocal, callbacks).play();

    expect(started).toBe(true);
    expect(instrumental.play).toHaveBeenCalledOnce();
    expect(vocal.play).toHaveBeenCalledOnce();
    expect(callbacks.onIsPlayingChange).toHaveBeenCalledWith(true);
  });

  it("pauses both tracks and remains stopped when one play rejects", async () => {
    const instrumental = new FakeAudioTrack();
    const vocal = new FakeAudioTrack();
    vocal.play.mockRejectedValueOnce(new Error("blocked"));
    const callbacks = createCallbacks();

    const started = await createDualAudioController(instrumental, vocal, callbacks).play();

    expect(started).toBe(false);
    expect(instrumental.pause).toHaveBeenCalledOnce();
    expect(vocal.pause).toHaveBeenCalledOnce();
    expect(callbacks.onIsPlayingChange).toHaveBeenCalledWith(false);
    expect(callbacks.onPlaybackError).toHaveBeenCalledOnce();
  });

  it("pauses both tracks", () => {
    const instrumental = new FakeAudioTrack();
    const vocal = new FakeAudioTrack();
    const callbacks = createCallbacks();

    createDualAudioController(instrumental, vocal, callbacks).pause();

    expect(instrumental.pause).toHaveBeenCalledOnce();
    expect(vocal.pause).toHaveBeenCalledOnce();
    expect(callbacks.onIsPlayingChange).toHaveBeenCalledWith(false);
  });

  it("seeks both tracks and publishes the master time", () => {
    const instrumental = new FakeAudioTrack();
    const vocal = new FakeAudioTrack();
    const callbacks = createCallbacks();

    createDualAudioController(instrumental, vocal, callbacks).seek(42);

    expect(instrumental.currentTime).toBe(42);
    expect(vocal.currentTime).toBe(42);
    expect(callbacks.onCurrentTimeChange).toHaveBeenCalledWith(42);
  });

  it("updates only the vocal volume", () => {
    const instrumental = new FakeAudioTrack();
    const vocal = new FakeAudioTrack();
    const callbacks = createCallbacks();

    createDualAudioController(instrumental, vocal, callbacks).setVocalVolume(35);

    expect(vocal.volume).toBe(0.35);
    expect(instrumental.volume).toBe(1);
  });

  it("uses instrumental time and duration as the master clock", () => {
    const instrumental = new FakeAudioTrack();
    const vocal = new FakeAudioTrack();
    instrumental.currentTime = 64;
    instrumental.duration = 201;
    const callbacks = createCallbacks();
    const controller = createDualAudioController(instrumental, vocal, callbacks);

    controller.handleMasterTimeUpdate();
    controller.updateDuration();

    expect(callbacks.onCurrentTimeChange).toHaveBeenCalledWith(64);
    expect(callbacks.onMasterTimeUpdate).toHaveBeenCalledWith(64);
    expect(callbacks.onDurationChange).toHaveBeenCalledWith(201);
  });

  it("stops playback when the instrumental track ends", () => {
    const instrumental = new FakeAudioTrack();
    const vocal = new FakeAudioTrack();
    const callbacks = createCallbacks();

    createDualAudioController(instrumental, vocal, callbacks).handleMasterEnded();

    expect(callbacks.onIsPlayingChange).toHaveBeenCalledWith(false);
  });

  it("coalesces simultaneous play requests", async () => {
    const instrumental = new FakeAudioTrack();
    const vocal = new FakeAudioTrack();
    const instrumentalPlay = deferred();
    const vocalPlay = deferred();
    instrumental.play.mockReturnValueOnce(instrumentalPlay.promise);
    vocal.play.mockReturnValueOnce(vocalPlay.promise);
    const controller = createDualAudioController(instrumental, vocal, createCallbacks());

    const first = controller.play();
    const second = controller.play();
    instrumentalPlay.resolve();
    vocalPlay.resolve();

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(instrumental.play).toHaveBeenCalledOnce();
    expect(vocal.play).toHaveBeenCalledOnce();
  });

  it("does not report playing after pause invalidates a pending play", async () => {
    const instrumental = new FakeAudioTrack();
    const vocal = new FakeAudioTrack();
    const instrumentalPlay = deferred();
    const vocalPlay = deferred();
    instrumental.play.mockReturnValueOnce(instrumentalPlay.promise);
    vocal.play.mockReturnValueOnce(vocalPlay.promise);
    const callbacks = createCallbacks();
    const controller = createDualAudioController(instrumental, vocal, callbacks);

    const started = controller.play();
    controller.pause();
    instrumentalPlay.resolve();
    vocalPlay.resolve();

    await expect(started).resolves.toBe(false);
    expect(callbacks.onIsPlayingChange).not.toHaveBeenCalledWith(true);
  });

  it("ignores completion after disposal", async () => {
    const instrumental = new FakeAudioTrack();
    const vocal = new FakeAudioTrack();
    const instrumentalPlay = deferred();
    const vocalPlay = deferred();
    instrumental.play.mockReturnValueOnce(instrumentalPlay.promise);
    vocal.play.mockReturnValueOnce(vocalPlay.promise);
    const callbacks = createCallbacks();
    const controller = createDualAudioController(instrumental, vocal, callbacks);

    const started = controller.play();
    controller.dispose();
    instrumentalPlay.resolve();
    vocalPlay.resolve();

    await expect(started).resolves.toBe(false);
    expect(callbacks.onIsPlayingChange).not.toHaveBeenCalled();
  });

  it("invalidates the prior source before a replacement controller starts", async () => {
    const oldInstrumental = new FakeAudioTrack();
    const oldVocal = new FakeAudioTrack();
    const oldInstrumentalPlay = deferred();
    const oldVocalPlay = deferred();
    oldInstrumental.play.mockReturnValueOnce(oldInstrumentalPlay.promise);
    oldVocal.play.mockReturnValueOnce(oldVocalPlay.promise);
    const oldCallbacks = createCallbacks();
    const oldController = createDualAudioController(oldInstrumental, oldVocal, oldCallbacks);

    const oldPlay = oldController.play();
    oldController.dispose();
    const nextCallbacks = createCallbacks();
    const nextController = createDualAudioController(
      new FakeAudioTrack(),
      new FakeAudioTrack(),
      nextCallbacks,
    );
    oldInstrumentalPlay.resolve();
    oldVocalPlay.resolve();

    await expect(oldPlay).resolves.toBe(false);
    await expect(nextController.play()).resolves.toBe(true);
    expect(oldCallbacks.onIsPlayingChange).not.toHaveBeenCalled();
    expect(nextCallbacks.onIsPlayingChange).toHaveBeenCalledWith(true);
  });

  it("does not let a stale rejection alter a newer play operation", async () => {
    const instrumental = new FakeAudioTrack();
    const vocal = new FakeAudioTrack();
    const firstInstrumental = deferred();
    const firstVocal = deferred();
    instrumental.play.mockReturnValueOnce(firstInstrumental.promise);
    vocal.play.mockReturnValueOnce(firstVocal.promise);
    const callbacks = createCallbacks();
    const controller = createDualAudioController(instrumental, vocal, callbacks);

    const stale = controller.play();
    controller.pause();
    const current = controller.play();
    firstInstrumental.reject(new Error("blocked"));
    firstVocal.reject(new Error("blocked"));

    await expect(stale).resolves.toBe(false);
    await expect(current).resolves.toBe(true);
    expect(callbacks.onIsPlayingChange).toHaveBeenLastCalledWith(true);
    expect(instrumental.pause).toHaveBeenCalledOnce();
    expect(vocal.pause).toHaveBeenCalledOnce();
  });

  it("normalizes invalid master time and duration", () => {
    const instrumental = new FakeAudioTrack();
    const vocal = new FakeAudioTrack();
    const callbacks = createCallbacks();
    const controller = createDualAudioController(instrumental, vocal, callbacks);
    instrumental.currentTime = Number.NaN;
    instrumental.duration = Infinity;

    controller.handleMasterTimeUpdate();
    controller.updateDuration();

    expect(callbacks.onCurrentTimeChange).toHaveBeenCalledWith(0);
    expect(callbacks.onMasterTimeUpdate).toHaveBeenCalledWith(0);
    expect(callbacks.onDurationChange).toHaveBeenCalledWith(0);
  });

  it("clamps seek and vocal volume while ignoring non-finite seeks", () => {
    const instrumental = new FakeAudioTrack();
    const vocal = new FakeAudioTrack();
    instrumental.duration = 60;
    const callbacks = createCallbacks();
    const controller = createDualAudioController(instrumental, vocal, callbacks);

    controller.seek(-5);
    controller.seek(90);
    controller.seek(Infinity);
    controller.setVocalVolume(-10);
    controller.setVocalVolume(200);
    controller.setVocalVolume(Number.NaN);

    expect(instrumental.currentTime).toBe(60);
    expect(vocal.currentTime).toBe(60);
    expect(callbacks.onCurrentTimeChange).toHaveBeenLastCalledWith(60);
    expect(vocal.volume).toBe(0);
  });

  it("preserves the no-lyrics master-time behavior", () => {
    const instrumental = new FakeAudioTrack();
    const vocal = new FakeAudioTrack();
    instrumental.currentTime = 42;
    const callbacks = createCallbacks();
    callbacks.shouldUpdateMasterTime = () => false;
    const controller = createDualAudioController(instrumental, vocal, callbacks);

    controller.handleMasterTimeUpdate();

    expect(callbacks.onCurrentTimeChange).not.toHaveBeenCalled();
    expect(callbacks.onMasterTimeUpdate).toHaveBeenCalledWith(42);
  });
});
