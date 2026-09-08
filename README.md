# mp4 trimmer

Local web app for trimming video with ffmpeg. The default path is a stream copy
(`-c copy`), so cuts are near-instant and lossless — no re-encode.

## Running

    npm start

The server prints a URL with a one-time token:

    mp4 trimmer  http://127.0.0.1:5178/?token=8f3c...
    roots: /home/pi/media

Open it. The token is exchanged for a cookie, so the rest of the session needs
no token in the URL.

## Configuration

| Variable      | Default              | Meaning                                              |
| ------------- | -------------------- | ---------------------------------------------------- |
| `HOST`        | `127.0.0.1`          | Bind address. `0.0.0.0` exposes it to the LAN.        |
| `PORT`        | `5178`               | Listen port.                                          |
| `MEDIA_ROOTS` | your home directory  | Allowed directories, separated by `:` (`;` on Windows). |
| `UPLOAD_DIR`  | `<first root>/_uploads` | Where drag-and-drop fallback copies land.          |
| `TOKEN`       | random each boot     | Shared secret. Set it to keep URLs stable.            |
| `FFMPEG`      | `ffmpeg`             | Path to the binary.                                   |
| `FFPROBE`     | `ffprobe`            | Path to the binary.                                   |

## Security model

Two controls, both mandatory:

- **Token.** Every request needs it — via `?token=`, an `X-Token` header, or the
  cookie the first request sets. Compared with `timingSafeEqual`.
- **Root allowlist.** Every path the app reads, writes, probes, or lists is
  resolved (symlinks included) and rejected unless it sits inside `MEDIA_ROOTS`.
  Output files are refused if they already exist unless you tick overwrite.

Neither makes this safe to expose to the internet. It runs ffmpeg on paths you
supply; keep it on the LAN or behind a VPN, and never port-forward it.

## Raspberry Pi

Tested target: Pi 3 B+ or newer, 64-bit Raspberry Pi OS.

    sudo apt install nodejs ffmpeg
    git clone <repo> ~/mp4

    # secret, root-owned, not in the repo
    openssl rand -hex 16 | sed 's/^/TOKEN=/' | sudo tee /etc/mp4-trimmer.env
    sudo chmod 600 /etc/mp4-trimmer.env

    # edit User/WorkingDirectory/MEDIA_ROOTS to match your setup first
    sudo cp deploy/mp4-trimmer.service /etc/systemd/system/
    sudo systemctl enable --now mp4-trimmer
    journalctl -u mp4-trimmer -f          # prints the URL and token

The unit runs with `ProtectSystem=strict` and `ReadWritePaths` limited to the
media root, so the filesystem stays read-only to the service even if the
application-level path checks fail.

On a Pi 3 B+ the ethernet port shares USB 2.0 with storage, so expect roughly
10-15 MB/s end to end. Stream-copy trims are still fine; the re-encode checkbox
is effectively unusable at 1080p on that hardware.
