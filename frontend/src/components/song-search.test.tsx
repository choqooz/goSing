import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SongSearch } from "@/components/song-search";

const suggestions = ["Artista - Canción", "Otra canción"];
const results = [{ author: "Artista", thumb: "/cover.jpg", title: "Artista - Canción", videoId: "abc123" }];
const fetchMock = vi.fn<typeof fetch>();

function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }

describe("SongSearch", () => {
  beforeEach(() => { fetchMock.mockImplementation((input) => Promise.resolve(response(String(input).includes("/suggest") ? ["", suggestions] : results))); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); fetchMock.mockReset(); });

  it("navigates suggestions with the keyboard, selects the active option, and keeps focus", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<SongSearch onSelect={onSelect} />);

    const input = screen.getByRole("combobox", { name: "Buscar canción en YouTube" });
    await user.type(input, "ca"); await screen.findByRole("listbox");
    expect(screen.getByRole("listbox")).toBeVisible();
    await user.keyboard("{ArrowDown}");
    expect(input).toHaveAttribute("aria-activedescendant", expect.stringMatching(/option-0$/));
    await user.keyboard("{ArrowUp}");
    expect(input).toHaveAttribute("aria-activedescendant", expect.stringMatching(/option-1$/));
    await user.keyboard("{Enter}");

    expect(input).toHaveFocus(); expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Seleccionar Canción de Artista" })).toBeVisible();
  });

  it("uses clickable listbox options without nested buttons and preserves input focus", async () => {
    const user = userEvent.setup();
    render(<SongSearch onSelect={vi.fn()} />);

    const input = screen.getByRole("combobox", { name: "Buscar canción en YouTube" });
    await user.type(input, "ca");
    const option = await screen.findByRole("option", { name: suggestions[0] });

    expect(option.querySelector("button")).toBeNull();
    await user.click(option);

    expect(input).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes suggestions with Escape and clears the active option when typing", async () => {
    const user = userEvent.setup();
    render(<SongSearch onSelect={vi.fn()} />);

    const input = screen.getByRole("combobox", { name: "Buscar canción en YouTube" });
    await user.type(input, "ca"); await screen.findByRole("listbox");
    await user.keyboard("{ArrowDown}");
    await user.type(input, "n");
    expect(input).not.toHaveAttribute("aria-activedescendant");
    await user.keyboard("{Escape}");

    expect(input).toHaveFocus(); expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("uses native result buttons with accessible names", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<SongSearch onSelect={onSelect} />);
    await user.type(screen.getByRole("combobox"), "canción");
    await user.click(screen.getByRole("button", { name: "Buscar canción" }));

    const result = await screen.findByRole("button", { name: "Seleccionar Canción de Artista" });
    expect(result.querySelector("img")).toHaveAttribute("alt", "");
    await user.click(result);
    expect(onSelect).toHaveBeenCalledWith(results[0]);
  });

  it("announces search failures", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(response([], 500));
    render(<SongSearch onSelect={vi.fn()} />);
    await user.type(screen.getByRole("combobox"), "canción");
    await user.click(screen.getByRole("button", { name: "Buscar canción" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo buscar la canción. Intentá nuevamente.");
  });

  it("keeps newer search results when an older aborted request rejects", async () => {
    let rejectOlder!: (reason?: unknown) => void;
    let resolveNewer!: (value: Response) => void;
    const older = new Promise<Response>((_, reject) => { rejectOlder = reject; });
    const newer = new Promise<Response>((resolve) => { resolveNewer = resolve; });
    fetchMock.mockReset().mockReturnValueOnce(older).mockReturnValueOnce(newer);
    render(<SongSearch onSelect={vi.fn()} />);
    const input = screen.getByRole("combobox", { name: "Buscar canción en YouTube" });

    fireEvent.change(input, { target: { value: "anterior" } });
    fireEvent.submit(input.closest("form")!);
    const olderSignal = (fetchMock.mock.calls[0][1] as RequestInit).signal!;
    fireEvent.change(input, { target: { value: "nueva" } });
    fireEvent.submit(input.closest("form")!);
    expect(olderSignal.aborted).toBe(true);

    await act(async () => { resolveNewer(response([{ title: "Nueva canción", videoId: "new123" }])); });
    expect(await screen.findByRole("button", { name: "Seleccionar Nueva canción" })).toBeVisible();
    await act(async () => { rejectOlder(new DOMException("Aborted", "AbortError")); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("coalesces repeated submissions for a pending query", () => {
    fetchMock.mockReset().mockImplementationOnce(() => new Promise<Response>(() => {}));
    const { container } = render(<SongSearch onSelect={vi.fn()} />);
    const input = screen.getByRole("combobox", { name: "Buscar canción en YouTube" });

    fireEvent.change(input, { target: { value: "misma canción" } });
    fireEvent.submit(container.querySelector("form")!);
    fireEvent.submit(container.querySelector("form")!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps newer suggestions when an older request resolves later", async () => {
    vi.useFakeTimers();
    let resolveOlder!: (value: Response) => void;
    const older = new Promise<Response>((resolve) => { resolveOlder = resolve; });
    fetchMock.mockReset().mockReturnValueOnce(older).mockResolvedValueOnce(response(["", ["Nueva canción"]]));
    render(<SongSearch onSelect={vi.fn()} />);
    const input = screen.getByRole("combobox", { name: "Buscar canción en YouTube" });

    fireEvent.change(input, { target: { value: "an" } });
    await act(async () => { vi.advanceTimersByTime(300); });
    fireEvent.change(input, { target: { value: "nueva" } });
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(screen.getByRole("option", { name: "Nueva canción" })).toBeVisible();

    await act(async () => { resolveOlder(response(["", ["Anterior canción"]])); });
    expect(screen.queryByRole("option", { name: "Anterior canción" })).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("aborts pending suggestions on unmount", async () => {
    vi.useFakeTimers();
    let resolveSuggestion!: (value: Response) => void;
    fetchMock.mockReset().mockImplementationOnce((_, init) => {
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
      return new Promise<Response>((resolve) => { resolveSuggestion = resolve; });
    });
    const { unmount } = render(<SongSearch onSelect={vi.fn()} />);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "ca" } });
    await act(async () => { vi.advanceTimersByTime(300); });
    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal!;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { resolveSuggestion(response(["", suggestions])); });
    vi.useRealTimers();
  });

  it("aborts a pending search on unmount", () => {
    fetchMock.mockReset().mockImplementationOnce(() => new Promise<Response>(() => {}));
    const { unmount } = render(<SongSearch onSelect={vi.fn()} />);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "canción" } });
    fireEvent.submit(screen.getByRole("combobox").closest("form")!);
    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal!;
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it("stacks the form and makes the submit button full width on mobile", () => {
    const { container } = render(<SongSearch onSelect={vi.fn()} />);

    expect(container.querySelector("form")).toHaveClass("flex-col", "sm:flex-row");
    expect(screen.getByRole("button", { name: /^Buscar$/ })).toHaveClass("w-full", "sm:w-auto");
  });
});
