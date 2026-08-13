import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LyricsList } from "@/components/lyrics-list";
import { PlayerControls } from "@/components/player-controls";

describe("player accessibility", () => {
  it("names controls, exposes slider values, and announces playback failures", () => {
    render(<PlayerControls currentTime={42} duration={180} isPlaying={false} onSeek={vi.fn()} onTogglePlay={vi.fn().mockResolvedValue(false)} onVocalVolumeChange={vi.fn()} playbackError="No se pudo iniciar la reproducción." vocalVolume={[35]} />);

    expect(screen.getByRole("button", { name: "Reproducir" })).toBeVisible();
    for (const name of ["Repetir (no disponible)", "Retroceder (no disponible)", "Avanzar (no disponible)"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      expect(button).toHaveClass("disabled:opacity-50");
      expect(button).not.toHaveClass("disabled:opacity-100", "hover:bg-white/10", "hover:text-white", "active:scale-[0.96]");
    }
    expect(screen.getByRole("slider", { name: "Progreso de reproducción" })).toHaveAttribute("aria-valuetext", "00:42 de 03:00");
    expect(screen.getByRole("slider", { name: "Volumen de voz original" })).toHaveAttribute("aria-valuetext", "35%");
    expect(screen.getByRole("alert")).toHaveTextContent("No se pudo iniciar la reproducción.");
  });

  it("renames the primary control while playing", () => {
    render(<PlayerControls currentTime={0} duration={0} isPlaying onSeek={vi.fn()} onTogglePlay={vi.fn().mockResolvedValue(false)} onVocalVolumeChange={vi.fn()} playbackError="" vocalVolume={[50]} />);

    expect(screen.getByRole("button", { name: "Pausar" })).toBeVisible();
  });

  it("seeks from a lyric button and identifies the active line", async () => {
    const user = userEvent.setup();
    const onSeek = vi.fn();
    render(<LyricsList currentLyricIndex={1} lyrics={[{ time: 12, text: "Primera línea" }, { time: 24, text: "Segunda línea" }]} onSeek={onSeek} />);

    const activeLine = screen.getByRole("button", { name: "Ir a 00:24: Segunda línea" });
    expect(activeLine).toHaveAttribute("aria-current", "true");
    await user.click(activeLine);
    expect(onSeek).toHaveBeenCalledWith(24);
  });

  it("uses mobile-safe player and lyrics layout classes", () => {
    const { container } = render(<><PlayerControls currentTime={0} duration={0} isPlaying={false} onSeek={vi.fn()} onTogglePlay={vi.fn().mockResolvedValue(false)} onVocalVolumeChange={vi.fn()} playbackError="" vocalVolume={[50]} /><LyricsList currentLyricIndex={0} lyrics={[{ time: 0, text: "Primera línea" }]} onSeek={vi.fn()} /></>);

    expect(container.firstElementChild).toHaveClass("p-5", "sm:p-8");
    expect(container.lastElementChild).toHaveClass("py-16", "lg:py-32");
  });
});
