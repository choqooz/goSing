import { Pause, Play, Repeat, SkipBack, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";

interface PlayerControlsProps {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  onSeek: (time: number) => void;
  onTogglePlay: () => Promise<boolean | undefined>;
  onVocalVolumeChange: (value: number[]) => void;
  playbackError: string;
  vocalVolume: number[];
}

function formatTime(seconds: number) {
  if (!seconds || Number.isNaN(seconds)) return "00:00";
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
}

const iconButtonClass = "rounded-full w-12 h-12 transition motion-reduce:transition-none motion-reduce:transform-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50";

export function PlayerControls({
  currentTime,
  duration,
  isPlaying,
  onSeek,
  onTogglePlay,
  onVocalVolumeChange,
  playbackError,
  vocalVolume,
}: PlayerControlsProps) {
  const playbackMaximum = duration || 100;

  return (
    <div className="flex flex-col gap-6 bg-white/[0.04] backdrop-blur-2xl saturate-[180%] border border-white/10 p-5 sm:p-8 rounded-[2rem] shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_12px_40px_rgba(0,0,0,0.5)] shrink-0">
      {playbackError && <p role="alert" className="sr-only">{playbackError}</p>}
      <div className="flex items-center gap-2 sm:gap-4 w-full">
        <span className="text-xs font-medium text-white/50 w-10 sm:w-12 text-right tabular-nums">{formatTime(currentTime)}</span>
        <Slider
          value={[currentTime]}
          max={playbackMaximum}
          step={1}
          min={0}
          aria-label="Progreso de reproducción"
          aria-valuemin={0}
          aria-valuemax={playbackMaximum}
          aria-valuenow={currentTime}
          aria-valuetext={`${formatTime(currentTime)} de ${formatTime(duration)}`}
          onValueChange={(value: number[]) => onSeek(value[0])}
          className="flex-1 cursor-pointer"
        />
        <span className="text-xs font-medium text-white/50 w-10 sm:w-12 tabular-nums">{formatTime(duration)}</span>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <Button disabled title="No disponible" aria-label="Repetir (no disponible)" variant="ghost" size="icon" className={`text-white/60 ${iconButtonClass}`}>
          <Repeat className="w-5 h-5" />
        </Button>

        <div className="flex items-center justify-center gap-3 sm:gap-6">
          <Button disabled title="No disponible" aria-label="Retroceder (no disponible)" variant="ghost" size="icon" className={`text-white ${iconButtonClass}`}>
            <SkipBack className="w-6 h-6" />
          </Button>
          <Button onClick={() => void onTogglePlay()} aria-label={isPlaying ? "Pausar" : "Reproducir"} className="w-20 h-20 rounded-full bg-white text-black hover:scale-[1.03] active:scale-[0.96] transition motion-reduce:transition-none motion-reduce:transform-none shadow-[0_4px_20px_rgba(255,255,255,0.3)] border-0 flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50">
            {isPlaying ? <Pause className="w-8 h-8 fill-current" /> : <Play className="w-8 h-8 fill-current translate-x-0.5" />}
          </Button>
          <Button disabled title="No disponible" aria-label="Avanzar (no disponible)" variant="ghost" size="icon" className={`text-white/80 ${iconButtonClass}`}>
            <SkipForward className="w-6 h-6" />
          </Button>
        </div>

        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:gap-4 bg-white/[0.04] backdrop-blur-2xl saturate-[180%] border border-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.1)] px-4 py-4 sm:px-6 sm:py-3 rounded-2xl">
          <div className="flex flex-col">
            <span className="text-xs font-bold text-white/90 uppercase tracking-wider">Voz Original</span>
            <span className="text-white/50 text-[10px]">Ajustá el cantante original</span>
          </div>
          <Slider
            value={vocalVolume}
            onValueChange={onVocalVolumeChange}
            max={100}
            min={0}
            step={1}
            aria-label="Volumen de voz original"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={vocalVolume[0]}
            aria-valuetext={`${vocalVolume[0]}%`}
            className="w-full sm:w-32"
          />
        </div>
      </div>
    </div>
  );
}
