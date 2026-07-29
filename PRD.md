# Product Requirements Document: AI Karaoke Web App

## 1. Overview
A web-based karaoke application that allows users to upload commercial audio tracks, removes the vocal stem using AI, and presents a synced karaoke player. The application is designed to operate within strict resource constraints, specifically targeting deployment on a free-tier VPS (1GB RAM).

## 2. Target Audience & Use Case
- **Users**: Individuals who want to practice singing or enjoy karaoke using well-known commercial songs.
- **Primary Flow**: User uploads an audio file -> System processes it to remove vocals and fetches synced lyrics -> User interacts with a web player to sing along with the instrumental track.

## 3. Architecture & Constraints
Due to the constraints of a free-tier VPS, the architecture requires offloading heavy tasks. The backend acts primarily as a lightweight orchestrator:
- **Ephemeral Processing**: The system will not persist processed audio files or lyrics. Data is held temporarily only for the duration of the user's session and then discarded.
- **Distributed AI Processing (Tunnel)**: Vocal removal (stem separation) is delegated to a local worker machine equipped with a dedicated GPU (AMD 6700 XT). This worker runs the Demucs model and exposes an API to the VPS via a secure tunnel (e.g., Cloudflare Tunnels/Ngrok).
- **External Lyrics Resolution**: Synchronized lyrics (`.lrc` format) will be fetched from a third-party public API based on the audio metadata.

## 4. Functional Requirements
### 4.1. File Upload & Metadata
- The frontend must allow users to upload standard audio formats (MP3, WAV).
- The system must extract audio metadata or prompt the user to input the Artist and Song Title to accurately fetch the corresponding lyrics.

### 4.2. Audio Processing (Vocal Removal)
- The backend orchestrates a request to the remote Tunnel URL for stem separation.
- The UI must handle asynchronous processing states (e.g., long-polling or WebSockets) to show progress, as stem separation may take over a minute.

### 4.3. Lyrics Fetching
- The backend queries an external API for `.lrc` (LyricRC) data using the provided song metadata.
- If lyrics are not found, the system should gracefully fallback, allowing the user to play the instrumental track without synced lyrics.

### 4.4. Karaoke Web Player
- A custom web audio player that plays the returned instrumental track.
- A parsing engine that reads the `.lrc` timestamps and highlights the corresponding text on the UI in real-time as the audio plays.

## 5. Non-Functional Requirements
- **Performance**: The frontend must remain responsive while background processing occurs.
- **Cost/Infrastructure**: The backend must adhere strictly to free-tier constraints, utilizing a highly memory-efficient runtime.
- **Security**: Uploaded files must be validated to prevent malicious payloads, and temporary files must be securely wiped after the request completes.

## 6. Technology Stack (Decided)
- **Backend**: Go (Golang). Chosen for its extremely low memory footprint (crucial for a free VPS), native concurrency for handling multiple uploads/WebSockets, and clean architecture enforcement.
- **Frontend**: React (or Vue) bundled with Vite (SPA).
- **AI Audio Processing**: Demucs model running on a local worker (AMD ROCm PyTorch), exposed via an HTTP server and a Tunnel.
- **Lyrics Provider**: LRCLIB or similar public `.lrc` API.

## 7. Future Enhancements (Out of Scope for MVP)
- User accounts and session history.
- Local Whisper-based transcription for unknown/indie audio tracks.
- Caching processed tracks to a cloud storage bucket to reduce API costs on duplicate requests.
