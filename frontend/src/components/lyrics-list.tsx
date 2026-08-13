interface LyricLine {
  text: string;
  time: number;
}

interface LyricsListProps {
  currentLyricIndex: number;
  lyrics: LyricLine[];
  onSeek: (time: number) => void;
}

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
}

export function LyricsList({ currentLyricIndex, lyrics, onSeek }: LyricsListProps) {
  return (
    <ul className="py-16 sm:py-24 lg:py-32 flex flex-col gap-6 sm:gap-8 px-4 sm:px-8 list-none m-0" aria-label="Letras sincronizadas">
      {lyrics.map((line, index) => {
        const isActive = index === currentLyricIndex;
        const isPast = index < currentLyricIndex;

        return (
          <li key={index}>
            <button
              type="button"
              data-lyric-index={index}
              aria-current={isActive ? "true" : undefined}
              aria-label={`Ir a ${formatTime(line.time)}: ${line.text}`}
              className={`w-full border-0 bg-transparent p-0 text-2xl sm:text-3xl md:text-5xl font-bold text-center leading-tight transition duration-500 ease-out motion-reduce:transition-none motion-reduce:transform-none cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 ${
                isActive
                  ? "text-white scale-[1.05] opacity-100 drop-shadow-[0_4px_12px_rgba(255,255,255,0.1)]"
                  : isPast
                    ? "text-white/40 scale-100 opacity-50"
                    : "text-white/40 scale-100 opacity-50"
              }`}
              onClick={() => onSeek(line.time)}
            >
              {line.text}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
