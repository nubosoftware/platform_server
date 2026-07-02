# Removing ImageMagick from the platform_server image (no source required)

## Background

ImageMagick (`8:6.9.11.60`, Ubuntu 22.04 packages) is present **only** in the
`platformserver` container. It is **not used by Nubo**. It is pulled in only as a
soft (`Recommends`) dependency:

```
gstreamer1.0-plugins-bad  --Depends-->  libzbar0  --Recommends-->  libmagickcore-6.q16-6-extra  -->  (ImageMagick libs)
```

Only the ImageMagick **libraries** are installed (no `convert`/`identify`
command-line tools). Removing them does **not** affect GStreamer or `libzbar0`,
so audio streaming keeps working. Verified with a dry-run purge and a full
offline rebuild.

The four packages to remove:

- `libmagickcore-6.q16-6`
- `libmagickcore-6.q16-6-extra`
- `libmagickwand-6.q16-6`
- `imagemagick-6-common`

`apt-get autoremove` additionally cleans up ImageMagick's own now-orphaned
dependencies (libheif, libgs9-common, libdjvulibre, libfftw3, etc.).

> These steps run entirely against the **local dpkg database** — **no internet
> access is required**. This was validated by building the patched image with
> `--network=none`.

---

## Method A — Rebuild a patched image (recommended, persistent)

Layers a purge step on top of the shipped image. Durable across container
recreation. This is the same change now baked into the Dockerfile for future
builds.

### 1. Identify the exact image tag the container uses

```bash
docker inspect --format '{{.Config.Image}}' nubo-ps
# e.g. docker.nubosoftware.com:5000/nubo/platformserver:test
```

### 2. Back up the current image (rollback safety)

```bash
docker tag docker.nubosoftware.com:5000/nubo/platformserver:test \
           docker.nubosoftware.com:5000/nubo/platformserver:pre-imagemagick-removal
```

### 3. Create the patch Dockerfile

```bash
mkdir -p ~/im-patch && cd ~/im-patch
cat > Dockerfile <<'EOF'
ARG BASE_IMAGE=docker.nubosoftware.com:5000/nubo/platformserver:test
FROM ${BASE_IMAGE}
RUN apt-get purge -y \
      libmagickcore-6.q16-6 \
      libmagickcore-6.q16-6-extra \
      libmagickwand-6.q16-6 \
      imagemagick-6-common \
    && apt-get autoremove -y
EOF
```

### 4. Build, re-tagging to the SAME tag the deployment already references

```bash
docker build --network=none \
  --build-arg BASE_IMAGE=docker.nubosoftware.com:5000/nubo/platformserver:test \
  -t docker.nubosoftware.com:5000/nubo/platformserver:test .
```

### 5. Recreate the container from the patched image

Restart it the way the environment normally does (the Nubo installer/compose
script, or `docker run` with your existing flags). A plain `docker restart`
is **not** enough — the container must be **recreated** so it picks up the new
image layer:

```bash
docker stop nubo-ps && docker rm nubo-ps
# then re-run your normal platform_server start command / installer
```

---

## Method B — Patch the running container in place (quick, then persist)

Fastest way to remediate an already-running container. Persists across
`docker restart`, but is **lost if the container is removed/recreated** — so
follow with a `docker commit` (step 3) or, better, use Method A.

### 1. Purge inside the running container (run as root with `-u 0`)

```bash
docker exec -u 0 nubo-ps apt-get purge -y \
  libmagickcore-6.q16-6 libmagickcore-6.q16-6-extra \
  libmagickwand-6.q16-6 imagemagick-6-common
docker exec -u 0 nubo-ps apt-get autoremove -y
```

### 2. Verify (see below)

### 3. Persist the change to a new image

```bash
docker commit nubo-ps docker.nubosoftware.com:5000/nubo/platformserver:test
```

> Note: committing a running container also captures its current runtime state.
> Method A produces a cleaner image and is preferred for anything long-lived.

---

## Verification (run after either method)

```bash
# 1. ImageMagick must be GONE (expect no output):
docker exec nubo-ps dpkg -l | grep -i magick

# 2. GStreamer audio stack must still be PRESENT (expect two lines):
docker exec nubo-ps dpkg -l | grep -E "gstreamer1.0-plugins-bad|libzbar0"

# 3. GStreamer launcher still works (expect a version banner):
docker exec nubo-ps gst-launch-1.0 --version
```

Finally, confirm platform_server audio still functions (place/receive a call or
run a session that uses audio) — the removed package is unrelated to audio, so
this is just a sanity check.

---

## Rollback

**Method A:**

```bash
docker tag docker.nubosoftware.com:5000/nubo/platformserver:pre-imagemagick-removal \
           docker.nubosoftware.com:5000/nubo/platformserver:test
docker stop nubo-ps && docker rm nubo-ps
# re-run your normal platform_server start command
```

**Method B:** reinstalling requires the packages from a repo/mirror, so keep the
`pre-imagemagick-removal` image tag as your rollback path regardless of method.
