from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
ICON = ROOT / "assets/icons/icon-master.png"
BACKGROUND = ROOT / "assets/store/promo-background.png"
FONT = "/System/Library/Fonts/Hiragino Sans GB.ttc"


def font(size, index=0):
    return ImageFont.truetype(FONT, size=size, index=index)


def cover(image, size):
    ratio = max(size[0] / image.width, size[1] / image.height)
    resized = image.resize((round(image.width * ratio), round(image.height * ratio)), Image.Resampling.LANCZOS)
    left = (resized.width - size[0]) // 2
    top = (resized.height - size[1]) // 2
    return resized.crop((left, top, left + size[0], top + size[1]))


def rounded(draw, box, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def build_icons():
    master = Image.open(ICON).convert("RGBA")
    for size in (16, 32, 48, 128):
        master.resize((size, size), Image.Resampling.LANCZOS).save(ROOT / f"assets/icons/icon-{size}.png")


def add_copy(canvas, title, subtitle, bullets=None):
    draw = ImageDraw.Draw(canvas, "RGBA")
    rounded(draw, (56, 58, 600, canvas.height - 58), 34, (255, 255, 255, 226), (255, 255, 255, 245), 2)
    icon = Image.open(ROOT / "assets/icons/icon-128.png").convert("RGBA").resize((74, 74), Image.Resampling.LANCZOS)
    canvas.alpha_composite(icon, (92, 92))
    draw.text((92, 190), title, font=font(46), fill="#102A56", spacing=8)
    draw.text((92, 314), subtitle, font=font(23), fill="#52657F", spacing=7)
    y = 412
    for bullet in bullets or []:
        draw.ellipse((94, y + 8, 106, y + 20), fill="#00AEEB")
        draw.text((122, y), bullet, font=font(21), fill="#263E61")
        y += 48


def build_store_images():
    background = Image.open(BACKGROUND).convert("RGBA")

    screenshot = cover(background, (1280, 800))
    add_copy(screenshot, "按日期，轻松追完\n关注动态", "不用反复刷新，也不会漏掉\n目标日期的最后一条。", ["自动读取到前一天", "图文与视频统一整理", "缓存仅保存在本机"])
    screenshot.convert("RGB").save(ROOT / "assets/store/screenshot-1280x800.png", quality=94)

    cache = cover(background, (1280, 800)).filter(ImageFilter.GaussianBlur(0.25))
    add_copy(cache, "多账号隔离\n缓存清晰可控", "按 UID 分开保存，切换账号\n不会混入其他人的记录。", ["查看条数、日期与空间", "按日期或账号清除", "自动治理过期缓存"])
    cache.convert("RGB").save(ROOT / "assets/store/screenshot-cache-1280x800.png", quality=94)

    banner = cover(background, (1400, 560))
    overlay = Image.new("RGBA", banner.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay, "RGBA")
    draw.rectangle((0, 0, 690, 560), fill=(245, 250, 255, 236))
    banner = Image.alpha_composite(banner, overlay)
    draw = ImageDraw.Draw(banner)
    icon = Image.open(ROOT / "assets/icons/icon-128.png").convert("RGBA").resize((82, 82), Image.Resampling.LANCZOS)
    banner.alpha_composite(icon, (76, 70))
    draw.text((76, 178), "B站动态按天看", font=font(48), fill="#102A56")
    draw.text((76, 258), "按日期加载和整理关注动态", font=font(29), fill="#405B7A")
    draw.text((76, 324), "少一点刷新，多一点从容。", font=font(25), fill="#008DC2")
    rounded(draw, (76, 403, 374, 456), 26, "#00AEEB")
    draw.text((111, 414), "本地 · 只读 · 分账号", font=font(20), fill="white")
    banner.convert("RGB").save(ROOT / "assets/store/promo-1400x560.png", quality=95)


if __name__ == "__main__":
    build_icons()
    build_store_images()
