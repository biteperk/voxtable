#!/usr/bin/env bash
# Build the optimised Bella portrait set served by the landing page.
#
# Source PNGs (1254x1254) live at repo-root public/images/.
# Output is the Vite-served public dir at apps/frontend/public/bella/.
# We emit pre-cropped AVIF/WebP/JPG at two aspect ratios so the hero and
# Meet Bella cards never rely on runtime object-fit guesswork.
#
# Tools required (all installed on the dev box already):
#   magick  ImageMagick 7   — cropping, resizing, colour-space strip
#   cwebp                   — WebP encoder
#   ffmpeg (libaom-av1)     — AVIF encoder (avifenc not installed)
set -euo pipefail

cd "$(dirname "$0")/.."

src_dir="public/images"
out="apps/frontend/public/bella"

src_hero="$src_dir/bella-6.png"    # headset, front-facing → hero
src_meet="$src_dir/bella-1.png"    # no headset, softer    → Meet Bella

for f in "$src_hero" "$src_meet"; do
  [[ -f "$f" ]] || { echo "missing source: $f" >&2; exit 1; }
done

for tool in magick cwebp ffmpeg; do
  command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 1; }
done

mkdir -p "$out"
rm -f "$out"/hero-*.{jpg,webp,avif} "$out"/meet-*.{jpg,webp,avif}
rm -f "$out"/hero.png "$out"/portrait.png   # stale leftovers from prior attempt

# JPG quality tuned to hit budgets while staying visually clean
# (AVIF/WebP carry the LCP for modern browsers; JPGs are legacy fallback only).
jpg_2x_q=80
jpg_1x_q=78

# 4:5 portrait crop (gravity North keeps the face in frame) — desktop card
magick "$src_hero" -gravity North -crop 4:5 +repage \
  -strip -colorspace sRGB -interlace JPEG -sampling-factor 4:2:0 \
  -resize 1080x1350 -quality "$jpg_2x_q" "$out/hero-portrait@2x.jpg"
magick "$out/hero-portrait@2x.jpg" -resize 720x900 -quality "$jpg_1x_q" "$out/hero-portrait.jpg"

# 1:1 crop — mobile hero card + general fallback
magick "$src_hero" -gravity Center -crop 1:1 +repage \
  -strip -colorspace sRGB -interlace JPEG -sampling-factor 4:2:0 \
  -resize 1080x1080 -quality "$jpg_2x_q" "$out/hero-square@2x.jpg"
magick "$out/hero-square@2x.jpg" -resize 540x540 -quality "$jpg_1x_q" "$out/hero-square.jpg"

# Meet Bella — 1:1, no headset variant
magick "$src_meet" -gravity Center -crop 1:1 +repage \
  -strip -colorspace sRGB -interlace JPEG -sampling-factor 4:2:0 \
  -resize 720x720 -quality "$jpg_1x_q" "$out/meet-portrait.jpg"

# WebP via cwebp
for jpg in "$out"/hero-*.jpg "$out"/meet-*.jpg; do
  cwebp -q 78 -m 6 -mt -quiet "$jpg" -o "${jpg%.jpg}.webp"
done

# AVIF via ffmpeg + libaom-av1 (still-picture mode, yuv420p for broadest support)
for jpg in "$out"/hero-*.jpg "$out"/meet-*.jpg; do
  ffmpeg -y -loglevel error -i "$jpg" \
    -frames:v 1 -c:v libsvtav1 -crf 35 -preset 6 \
    -pix_fmt yuv420p "${jpg%.jpg}.avif"
done

echo
echo "=== output ==="
ls -lh "$out" | awk '/\.(avif|webp|jpg)$/ {printf "  %-30s %s\n", $9, $5}'
