import { useEffect, useRef, useState } from "react";
import {
  createDualAudioController,
  type DualAudioController,
  type DualAudioCallbacks,
} from "@/player/dual-audio-controller";

interface UseDualAudioOptions {
  onMasterTimeUpdate: (time: number) => void;
  sourceKey: string;
  trackMasterTime: boolean;
}

export function useDualAudio({ onMasterTimeUpdate, sourceKey, trackMasterTime }: UseDualAudioOptions) {
  const instrumentalRef = useRef<HTMLAudioElement>(null);
  const vocalRef = useRef<HTMLAudioElement>(null);
  const controllerRef = useRef<DualAudioController | null>(null);
  const onMasterTimeUpdateRef = useRef(onMasterTimeUpdate);
  const trackMasterTimeRef = useRef(trackMasterTime);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [vocalVolume, setVocalVolumeState] = useState([50]);

  onMasterTimeUpdateRef.current = onMasterTimeUpdate;
  trackMasterTimeRef.current = trackMasterTime;

  const callbacks: DualAudioCallbacks = {
    onDurationChange: setDuration,
    onIsPlayingChange: setIsPlaying,
    onMasterTimeUpdate: (time) => onMasterTimeUpdateRef.current(time),
    onCurrentTimeChange: setCurrentTime,
    shouldUpdateMasterTime: () => trackMasterTimeRef.current,
  };

  const getController = () => {
    if (!instrumentalRef.current || !vocalRef.current) return null;
    if (!controllerRef.current) {
      controllerRef.current = createDualAudioController(instrumentalRef.current, vocalRef.current, callbacks);
    }
    return controllerRef.current;
  };

  const togglePlay = async () => {
    const controller = getController();
    if (!controller) return;
    await controller.toggle();
  };

  const seek = (time: number) => getController()?.seek(time);
  const handleMasterLoadedMetadata = () => {
    const controller = getController();
    if (!controller) return;
    controller.updateDuration();
    controller.setVocalVolume(vocalVolume[0]);
  };
  const handleMasterTimeUpdate = () => getController()?.handleMasterTimeUpdate();
  const handleMasterEnded = () => getController()?.handleMasterEnded();

  const setVocalVolume = (value: number[]) => {
    const percentage = Number.isFinite(value[0]) ? Math.min(100, Math.max(0, value[0])) : 0;
    setVocalVolumeState([percentage]);
    getController()?.setVocalVolume(percentage);
  };

  useEffect(() => {
    controllerRef.current?.dispose();
    controllerRef.current = null;
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    return () => {
      controllerRef.current?.dispose();
      controllerRef.current = null;
    };
  }, [sourceKey]);

  return {
    currentTime,
    duration,
    handleMasterEnded,
    handleMasterLoadedMetadata,
    handleMasterTimeUpdate,
    instrumentalRef,
    isPlaying,
    seek,
    setVocalVolume,
    togglePlay,
    vocalRef,
    vocalVolume,
  };
}
