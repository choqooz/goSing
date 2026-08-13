import { Upload } from "lucide-react";

interface UploadDropzoneProps {
  error: string;
  file: File | null;
  onFileChange: (file: File) => void;
}

const ACCEPTED_AUDIO_TYPES = [
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/x-m4a",
  "audio/ogg",
  "audio/flac",
  ".mp3",
  ".wav",
  ".m4a",
  ".ogg",
  ".flac",
].join(",");

export function UploadDropzone({ error, file, onFileChange }: UploadDropzoneProps) {
  const selectFile = (files: FileList | null) => {
    const selectedFile = files?.[0];
    if (selectedFile) onFileChange(selectedFile);
  };

  return (
    <>
      <input
        id="file-upload"
        type="file"
        accept={ACCEPTED_AUDIO_TYPES}
        onChange={(event) => selectFile(event.target.files)}
        className="peer sr-only"
      />
      <label
        htmlFor="file-upload"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          selectFile(event.dataTransfer.files);
        }}
        className="w-full min-h-44 border-0 ring-1 ring-white/5 rounded-3xl p-6 sm:p-10 text-center hover:bg-white/10 active:scale-[0.98] transition motion-reduce:transition-none motion-reduce:transform-none cursor-pointer bg-black/20 relative shadow-[inset_0_4px_24px_rgba(0,0,0,0.4)] peer-focus-visible:ring-2 peer-focus-visible:ring-white/50"
      >
        <Upload aria-hidden="true" className="w-8 h-8 mx-auto text-white/50 mb-4" />
        <p className="text-white/70 font-medium text-pretty" aria-live="polite">
          {file ? file.name : "Arrastrá tu MP3 acá o hacé clic"}
        </p>
      </label>
      {error && <p role="alert" aria-live="assertive" className="text-red-400 text-sm">{error}</p>}
    </>
  );
}
