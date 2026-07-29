from pathlib import Path

from PIL import Image, ImageChops, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "apps" / "web" / "public" / "brand"
OUT.mkdir(parents=True, exist_ok=True)

PRIMARY = ROOT / "output" / "brand" / "sidecar-link-primary-lockup.png"
SYMBOL = ROOT / "output" / "brand" / "sidecar-link-app-icon.png"


def remove_white_and_crop(source: Path, destination: Path, max_size: int) -> Image.Image:
    image = Image.open(source).convert("RGBA")
    pixels = image.load()
    for y in range(image.height):
        for x in range(image.width):
            red, green, blue, alpha = pixels[x, y]
            distance_from_white = max(255 - red, 255 - green, 255 - blue)
            if distance_from_white < 28:
                alpha = 0
            else:
                alpha = min(255, (distance_from_white - 28) * 10)
            pixels[x, y] = (red, green, blue, alpha)

    bbox = image.getchannel("A").getbbox()
    if bbox:
        image = image.crop(bbox)
    image.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
    image.save(destination, optimize=True)
    return image


primary = remove_white_and_crop(PRIMARY, OUT / "mcai-logo-primary.png", 1400)
symbol = remove_white_and_crop(SYMBOL, OUT / "mcai-symbol.png", 720)

for size in (192, 512):
    canvas = Image.new("RGBA", (size, size), "#FFFFFF")
    mark = symbol.copy()
    mark.thumbnail((int(size * 0.76), int(size * 0.76)), Image.Resampling.LANCZOS)
    x = (size - mark.width) // 2
    y = (size - mark.height) // 2
    canvas.alpha_composite(mark, (x, y))
    canvas.convert("RGB").save(OUT / f"mcai-icon-{size}.png", optimize=True)
