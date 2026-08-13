export interface AudioTrack {
  currentTime: number;
  duration: number;
  volume: number;
  pause: () => void;
  play: () => Promise<void>;
}

export interface DualAudioCallbacks {
  onDurationChange: (duration: number) => void;
  onIsPlayingChange: (isPlaying: boolean) => void;
  onMasterTimeUpdate: (time: number) => void;
  onCurrentTimeChange: (time: number) => void;
  shouldUpdateMasterTime?: () => boolean;
}

export interface DualAudioController {
  handleMasterEnded: () => void;
  handleMasterTimeUpdate: () => void;
  updateDuration: () => void;
  dispose: () => void;
  pause: () => void;
  play: () => Promise<boolean>;
  toggle: () => Promise<boolean>;
  seek: (time: number) => void;
  setVocalVolume: (percentage: number) => void;
}

export function createDualAudioController(
  instrumental: AudioTrack,
  vocal: AudioTrack,
  callbacks: DualAudioCallbacks,
): DualAudioController {
  let disposed = false;
  let generation = 0;
  let isPlaying = false;
  let pendingPlay: Promise<boolean> | null = null;

  const publishPlaying = (playing: boolean) => {
    if (disposed) return;
    isPlaying = playing;
    callbacks.onIsPlayingChange(playing);
  };

  const pause = () => {
    if (disposed) return;
    generation += 1;
    pendingPlay = null;
    instrumental.pause();
    vocal.pause();
    publishPlaying(false);
  };

  const play = () => {
    if (disposed) return Promise.resolve(false);
    if (pendingPlay) return pendingPlay;
    if (isPlaying) return Promise.resolve(true);

    const token = ++generation;
    const operation = Promise.allSettled([instrumental.play(), vocal.play()]).then((results) => {
      if (disposed || token !== generation) return false;
      pendingPlay = null;
      if (results.some((result) => result.status === "rejected")) {
        instrumental.pause();
        vocal.pause();
        publishPlaying(false);
        return false;
      }

      publishPlaying(true);
      return true;
    });
    pendingPlay = operation;
    return operation;
  };

  return {
    handleMasterEnded: () => {
      if (disposed) return;
      generation += 1;
      pendingPlay = null;
      publishPlaying(false);
    },
    handleMasterTimeUpdate: () => {
      if (disposed) return;
      const time = Number.isFinite(instrumental.currentTime)
        ? Math.max(0, instrumental.currentTime)
        : 0;
      if (callbacks.shouldUpdateMasterTime?.() ?? true) {
        callbacks.onCurrentTimeChange(time);
      }
      callbacks.onMasterTimeUpdate(time);
    },
    updateDuration: () => {
      if (disposed) return;
      const duration = instrumental.duration;
      callbacks.onDurationChange(Number.isFinite(duration) && duration > 0 ? duration : 0);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      generation += 1;
      pendingPlay = null;
      isPlaying = false;
      instrumental.pause();
      vocal.pause();
    },
    pause,
    play,
    toggle: () => {
      if (isPlaying || pendingPlay) {
        pause();
        return Promise.resolve(false);
      }
      return play();
    },
    seek: (time) => {
      if (disposed || !Number.isFinite(time)) return;
      const duration = instrumental.duration;
      const upperBound = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
      const safeTime = Math.min(Math.max(0, time), upperBound);
      instrumental.currentTime = safeTime;
      vocal.currentTime = safeTime;
      callbacks.onCurrentTimeChange(safeTime);
    },
    setVocalVolume: (percentage) => {
      if (disposed) return;
      const safePercentage = Number.isFinite(percentage)
        ? Math.min(100, Math.max(0, percentage))
        : 0;
      vocal.volume = safePercentage / 100;
    },
  };
}
