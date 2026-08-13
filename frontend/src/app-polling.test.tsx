import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "@/App";

vi.mock("@/components/song-search", () => ({
  SongSearch: ({ onSelect }: { onSelect: (result: { thumb?: string; title: string; videoId: string }) => void }) => <button onClick={() => onSelect({ title: "Canción", videoId: "video" })}>Iniciar procesamiento</button>,
}));
vi.mock("@/components/processing-status", () => ({ ProcessingStatus: () => <p>Procesando audio...</p> }));
vi.mock("@/components/upload-dropzone", () => ({
  UploadDropzone: ({ error, onFileChange }: { error: string; onFileChange: (file: File) => void }) => <>
    <button onClick={() => onFileChange(new File(["audio"], "nueva.mp3"))}>Elegir archivo</button>
    {error ? <p role="alert">{error}</p> : null}
  </>,
}));
vi.mock("@/components/lyrics-list", () => ({ LyricsList: () => null }));
vi.mock("@/components/player-controls", () => ({ PlayerControls: () => null }));
vi.mock("@/player/use-dual-audio", () => ({ useDualAudio: () => ({ currentTime: 0, duration: 0, handleMasterEnded: vi.fn(), handleMasterLoadedMetadata: vi.fn(), handleMasterTimeUpdate: vi.fn(), instrumentalRef: { current: null }, isPlaying: false, playbackError: "", seek: vi.fn(), setVocalVolume: vi.fn(), togglePlay: vi.fn(), vocalRef: { current: null }, vocalVolume: 1 }) }));

const fetchMock = vi.fn<typeof fetch>();
const pollingError = "No se pudo consultar el estado del procesamiento.";

function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }

function deferred<T>() {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, reject, resolve };
}

describe("App processing polling", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); fetchMock.mockReset(); });

  async function startProcessing() {
    fetchMock.mockResolvedValueOnce(response({ job_id: "job-1" }));
    render(<App />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Iniciar procesamiento" }));
      await Promise.resolve();
    });
    expect(screen.getByText("Procesando audio...")).toBeVisible();
  }

  it.each(["non-OK", "network error"]) ("leaves processing and announces a sanitized error on %s", async (failure) => {
    await startProcessing();
    if (failure === "non-OK") fetchMock.mockResolvedValueOnce(response({}, 500));
    else fetchMock.mockRejectedValueOnce(new Error("network"));

    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(screen.getByRole("alert")).toHaveTextContent(pollingError);
    expect(screen.queryByText("Procesando audio...")).not.toBeInTheDocument();
  });

  it("aborts an in-flight poll on cleanup without scheduling another request", async () => {
    await startProcessing();
    let resolvePoll!: (value: Response) => void;
    fetchMock.mockImplementationOnce((_, init) => {
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
      return new Promise<Response>((resolve) => { resolvePoll = resolve; });
    });
    await act(async () => { vi.advanceTimersByTime(3000); });
    const signal = (fetchMock.mock.calls[1][1] as RequestInit).signal!;
    cleanup();
    expect(signal.aborted).toBe(true);
    await act(async () => { resolvePoll(response({ status: "completed" })); vi.advanceTimersByTime(9000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not overlap polls while a status request is pending", async () => {
    await startProcessing();
    fetchMock.mockReturnValueOnce(new Promise<Response>(() => undefined));
    await act(async () => { vi.advanceTimersByTime(15000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores an older download response after a newer upload starts", async () => {
    const oldDownload = deferred<Response>();
    fetchMock.mockImplementationOnce(() => oldDownload.promise).mockResolvedValueOnce(response({ job_id: "upload-job" }));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Elegir archivo" }));

    await act(async () => {
      screen.getByRole("button", { name: "Iniciar procesamiento" }).click();
      screen.getByRole("button", { name: /Procesar Archivo/ }).click();
      await Promise.resolve();
    });

    const oldSignal = (fetchMock.mock.calls[0][1] as RequestInit).signal!;
    expect(oldSignal.aborted).toBe(true);
    expect(screen.getByText("Procesando audio...")).toBeVisible();

    await act(async () => { oldDownload.resolve(response({ job_id: "download-job" })); await Promise.resolve(); });
    expect(screen.getByText("Procesando audio...")).toBeVisible();

    fetchMock.mockResolvedValueOnce(response({ status: "processing" }));
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(fetchMock.mock.calls[2][0]).toBe("/api/audio/status?job_id=upload-job");
  });

  it("ignores an older download error after a newer upload starts", async () => {
    const oldDownload = deferred<Response>();
    fetchMock.mockImplementationOnce(() => oldDownload.promise).mockResolvedValueOnce(response({ job_id: "upload-job" }));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Elegir archivo" }));

    await act(async () => {
      screen.getByRole("button", { name: "Iniciar procesamiento" }).click();
      screen.getByRole("button", { name: /Procesar Archivo/ }).click();
      await Promise.resolve();
    });

    await act(async () => { oldDownload.reject(new Error("Error en la descarga")); await Promise.resolve(); });
    expect(screen.getByText("Procesando audio...")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("aborts an active ingress request on unmount", async () => {
    fetchMock.mockReturnValueOnce(new Promise<Response>(() => undefined));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Iniciar procesamiento" }));

    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal!;
    cleanup();
    expect(signal.aborted).toBe(true);
  });
});
