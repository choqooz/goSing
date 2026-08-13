import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessingStatus } from "@/components/processing-status";
import { UploadDropzone } from "@/components/upload-dropzone";

afterEach(cleanup);

describe("UploadDropzone", () => {
  it("associates an accessible label with the native file input", () => {
    render(<UploadDropzone error="" file={null} onFileChange={vi.fn()} />);

    const input = screen.getByLabelText("Arrastrá tu MP3 acá o hacé clic");
    expect(input).toHaveAttribute("type", "file");
    expect(input).toHaveAttribute("accept", expect.stringContaining(".flac"));
    expect(input.nextElementSibling).toHaveAttribute("for", input.id);
  });

  it("announces the selected filename", async () => {
    const user = userEvent.setup();
    const onFileChange = vi.fn();
    const { rerender } = render(<UploadDropzone error="" file={null} onFileChange={onFileChange} />);

    const file = new File(["audio"], "canción.mp3", { type: "audio/mpeg" });
    await user.upload(screen.getByLabelText("Arrastrá tu MP3 acá o hacé clic"), file);

    expect(onFileChange).toHaveBeenCalledWith(file);
    rerender(<UploadDropzone error="" file={file} onFileChange={onFileChange} />);
    expect(screen.getByText("canción.mp3")).toHaveAttribute("aria-live", "polite");
  });

  it("announces upload errors once through the global alert", () => {
    render(<UploadDropzone error="Error en la subida" file={null} onFileChange={vi.fn()} />);

    expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");
  });
});

describe("ProcessingStatus", () => {
  it("announces processing without exposing the decorative 66 percent progress", () => {
    render(<ProcessingStatus isUploading={false} />);

    expect(screen.getByRole("status")).toHaveTextContent("Procesando audio...");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
});
