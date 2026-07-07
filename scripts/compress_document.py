#!/usr/bin/env python3
"""
Compress document files without Ghostscript.

Dependencies:
- Pillow: image compression.
- pypdf: best-effort PDF stream/image compression.

This script never guarantees a PDF will be under target size; it prints JSON with
original/compressed size so the application can decide whether to validate or ask
for a lighter file.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import shutil
import sys
from pathlib import Path


def file_size(path: str | Path) -> int:
    try:
        return Path(path).stat().st_size
    except OSError:
        return 0


def json_exit(payload: dict, code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False))
    raise SystemExit(code)


def compress_image(input_path: Path, output_path: Path, target_bytes: int) -> dict:
    from PIL import Image, ImageOps

    original_size = file_size(input_path)
    best_bytes = None

    with Image.open(input_path) as img:
        img = ImageOps.exif_transpose(img)

        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        elif img.mode == "L":
            img = img.convert("RGB")

        # Try progressively smaller/stronger outputs.
        attempts = [
            (1600, 72), (1400, 65), (1200, 60), (1000, 55),
            (900, 50), (800, 45), (700, 40), (600, 38),
        ]

        for max_dim, quality in attempts:
            candidate = img.copy()
            candidate.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)

            buf = io.BytesIO()
            candidate.save(
                buf,
                format="JPEG",
                quality=quality,
                optimize=True,
                progressive=True,
                dpi=(96, 96),
            )
            data = buf.getvalue()

            if best_bytes is None or len(data) < len(best_bytes):
                best_bytes = data

            if len(data) <= target_bytes:
                break

    if best_bytes is None:
        shutil.copyfile(input_path, output_path)
    else:
        output_path.write_bytes(best_bytes)

    compressed_size = file_size(output_path)
    return {
        "ok": True,
        "type": "image",
        "original_size": original_size,
        "compressed_size": compressed_size,
        "improved": compressed_size < original_size,
        "output_path": str(output_path),
    }


def recompress_pdf_images(reader) -> int:
    """Best-effort recompress image XObjects. Returns number of images changed."""
    from PIL import Image, ImageOps
    from pypdf.generic import NameObject, NumberObject

    changed = 0

    for page in reader.pages:
        try:
            page.compress_content_streams()
        except Exception:
            pass

        try:
            resources = page.get("/Resources")
            if resources is None:
                continue
            resources = resources.get_object() if hasattr(resources, "get_object") else resources

            xobjects = resources.get("/XObject")
            if xobjects is None:
                continue
            xobjects = xobjects.get_object() if hasattr(xobjects, "get_object") else xobjects
        except Exception:
            continue

        for _name, obj_ref in list(xobjects.items()):
            try:
                obj = obj_ref.get_object() if hasattr(obj_ref, "get_object") else obj_ref
                if obj.get("/Subtype") != "/Image":
                    continue

                # Avoid breaking transparency-heavy PDFs.
                if obj.get("/SMask") is not None or obj.get("/Mask") is not None:
                    continue

                raw = obj.get_data()
                if not raw:
                    continue

                with Image.open(io.BytesIO(raw)) as img:
                    img = ImageOps.exif_transpose(img)
                    if img.mode not in ("RGB", "L"):
                        img = img.convert("RGB")
                    elif img.mode == "L":
                        img = img.convert("RGB")

                    img.thumbnail((1200, 1200), Image.Resampling.LANCZOS)

                    buf = io.BytesIO()
                    img.save(buf, format="JPEG", quality=50, optimize=True, progressive=True)
                    data = buf.getvalue()

                    # Only replace if actually smaller.
                    if len(data) >= len(raw):
                        continue

                    obj._data = data
                    obj[NameObject("/Filter")] = NameObject("/DCTDecode")
                    obj[NameObject("/ColorSpace")] = NameObject("/DeviceRGB")
                    obj[NameObject("/BitsPerComponent")] = NumberObject(8)
                    obj[NameObject("/Width")] = NumberObject(img.width)
                    obj[NameObject("/Height")] = NumberObject(img.height)

                    for key in ["/DecodeParms", "/Intent", "/Interpolate"]:
                        try:
                            if key in obj:
                                del obj[NameObject(key)]
                        except Exception:
                            pass

                    changed += 1
            except Exception:
                continue

    return changed


def compress_pdf(input_path: Path, output_path: Path, target_bytes: int) -> dict:
    from pypdf import PdfReader, PdfWriter

    original_size = file_size(input_path)
    best_path = output_path

    try:
        reader = PdfReader(str(input_path), strict=False)
        changed_images = recompress_pdf_images(reader)

        writer = PdfWriter()
        for page in reader.pages:
            writer.add_page(page)

        # Avoid preserving unnecessary metadata.
        try:
            writer.add_metadata({})
        except Exception:
            pass

        with open(output_path, "wb") as fh:
            writer.write(fh)

        compressed_size = file_size(output_path)

        # If pypdf output is invalid/empty or bigger, keep original copy but still report attempt.
        if not compressed_size:
            shutil.copyfile(input_path, output_path)
            compressed_size = file_size(output_path)

        if compressed_size > original_size:
            shutil.copyfile(input_path, output_path)
            compressed_size = file_size(output_path)

        return {
            "ok": True,
            "type": "pdf",
            "original_size": original_size,
            "compressed_size": compressed_size,
            "improved": compressed_size < original_size,
            "changed_images": changed_images,
            "output_path": str(best_path),
            "note": "Best-effort PDF compression with pypdf/Pillow. Some PDFs may not shrink enough without rasterizing.",
        }
    except Exception as exc:
        shutil.copyfile(input_path, output_path)
        return {
            "ok": True,
            "type": "pdf",
            "original_size": original_size,
            "compressed_size": file_size(output_path),
            "improved": False,
            "output_path": str(output_path),
            "warning": f"No se pudo recomprimir el PDF; se conservó el original: {exc}",
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_path")
    parser.add_argument("output_path")
    parser.add_argument("--mime", default="")
    parser.add_argument("--target-bytes", type=int, default=5 * 1024 * 1024)
    args = parser.parse_args()

    input_path = Path(args.input_path)
    output_path = Path(args.output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if not input_path.exists():
        json_exit({"ok": False, "reason": "No existe el archivo de entrada."}, 2)

    mime = (args.mime or "").lower()
    suffix = input_path.suffix.lower()

    try:
        if mime.startswith("image/") or suffix in {".jpg", ".jpeg", ".png", ".webp"}:
            payload = compress_image(input_path, output_path, args.target_bytes)
        elif mime == "application/pdf" or suffix == ".pdf":
            payload = compress_pdf(input_path, output_path, args.target_bytes)
        else:
            shutil.copyfile(input_path, output_path)
            payload = {
                "ok": False,
                "reason": "Tipo de archivo no soportado para compresión.",
                "original_size": file_size(input_path),
                "compressed_size": file_size(output_path),
                "output_path": str(output_path),
            }
    except Exception as exc:
        try:
            shutil.copyfile(input_path, output_path)
        except Exception:
            pass
        payload = {
            "ok": False,
            "reason": str(exc),
            "original_size": file_size(input_path),
            "compressed_size": file_size(output_path),
            "output_path": str(output_path),
        }

    json_exit(payload)


if __name__ == "__main__":
    main()
