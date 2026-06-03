# Continuous deployment (NAS / home server)

Push to `main` → GitHub Actions builds the image and publishes it to GHCR →
the NAS auto-pulls and recreates the container. Your data stays in the
`hon-data` Docker volume the whole time, so updates never touch it.

## Pipeline

- **CI** — `.github/workflows/docker-publish.yml` builds `Dockerfile`
  (`linux/amd64`) and pushes `ghcr.io/motionpeak/hon:latest` (+ a `sha-…` tag)
  on every push to `main`. The image is **private**.
- **CD** — `deploy/docker-compose.cd.yml` runs Hon from that image plus a
  **Watchtower** sidecar that polls GHCR every 5 minutes and recreates `hon`
  when a new image lands. Watchtower is label-scoped (`watchtower.enable=true`
  on `hon` only) so it never touches other containers on the box.

## One-time NAS setup

1. **Create a read-only token** to pull the private image: GitHub → Settings →
   Developer settings → Personal access tokens → **Tokens (classic)** →
   Generate, scope **`read:packages`** only.

2. **Log in to GHCR** on the NAS (Synology runs Docker as root):
   ```bash
   echo <TOKEN> | sudo docker login ghcr.io -u <github-username> --password-stdin
   ```

3. **Start it** (reuse the existing data volume by keeping the `hon-deploy`
   project name):
   ```bash
   cp .env.example .env          # set HON_TOKEN
   sudo docker compose -p hon-deploy -f docker-compose.cd.yml up -d
   ```

After that, every push to `main` lands on the NAS within ~5 minutes, untouched.

## Manual update (if you ever disable Watchtower)

```bash
sudo docker compose -p hon-deploy -f docker-compose.cd.yml pull
sudo docker compose -p hon-deploy -f docker-compose.cd.yml up -d
```
