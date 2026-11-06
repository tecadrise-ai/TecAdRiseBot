"""Rebuild tecadrisebot-v2.ico with classic BMP DIB images (Explorer/NSIS/DC)."""
from __future__ import annotations

import struct
from pathlib import Path

from PIL import Image

SRC = Path(__file__).resolve().parents[1] / "resources" / "tecadrisebot-v2.ico"
SIZES = (16, 24, 32, 48, 64, 128, 256)


def dib(img: Image.Image) -> bytes:
    img = img.convert("RGBA")
    w, h = img.size
    pix = img.load()
    xor = bytearray()
    for y in range(h - 1, -1, -1):
        for x in range(w):
            r, g, b, a = pix[x, y]
            xor += bytes((b, g, r, a))
    stride = ((w + 31) // 32) * 4
    mask = bytearray(stride * h)
    for y in range(h):
        dest_y = h - 1 - y
        for x in range(w):
            if pix[x, y][3] < 128:
                mask[dest_y * stride + (x // 8)] |= 0x80 >> (x % 8)
    hdr = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, len(xor), 0, 0, 0, 0)
    return hdr + xor + bytes(mask)


def main() -> None:
    ico = Image.open(SRC)
    frames: dict[int, Image.Image] = {}
    for i in range(getattr(ico, "n_frames", 1)):
        ico.seek(i)
        frames[ico.size[0]] = ico.copy()
        print("frame", i, ico.size, ico.mode)

    blobs: list[bytes] = []
    for s in SIZES:
        base = frames.get(s) or frames.get(256) or ico
        if base.size != (s, s):
            base = base.resize((s, s), Image.Resampling.LANCZOS)
        blobs.append(dib(base))

    count = len(blobs)
    offset = 6 + 16 * count
    out = bytearray(struct.pack("<HHH", 0, 1, count))
    payload = bytearray()
    for s, data in zip(SIZES, blobs):
        dim = 0 if s >= 256 else s
        out += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        payload += data
        offset += len(data)
    SRC.write_bytes(bytes(out) + bytes(payload))
    raw = SRC.read_bytes()
    n = struct.unpack_from("<H", raw, 4)[0]
    print("wrote", SRC, SRC.stat().st_size, "images", n)
    for i in range(n):
        off = 6 + i * 16
        w = raw[off] or 256
        img_off = struct.unpack_from("<I", raw, off + 12)[0]
        print(w, raw[img_off : img_off + 4])


if __name__ == "__main__":
    main()
