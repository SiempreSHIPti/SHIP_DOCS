#!/usr/bin/env python3
"""
Compress document files without Ghostscript.

Dependencies:
- Pillow: image compression.
- pypdf: structural best-effort PDF compression.
- pypdfium2: PDF rendering/raster fallback using PDFium.

PDF compression strategy:
1) Try structural recompression with pypdf/Pillow.
2) If it does not reduce enough, render pages to compressed images and rebuild a light PDF.
3) Report original/final size so the app can validate only if <= target size.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import shutil
import sys
import tempfile
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
    best_meta = {}

    with Image.open(input_path) as img:
        img = ImageOps.exif_transpose(img)

        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        elif img.mode == "L":
            img = img.convert("RGB")

        attempts = [
            (1800, 72), (1600, 68), (1400, 64), (1200, 60),
            (1000, 56), (900, 52), (800, 48), (700, 44),
            (600, 40), (520, 36),
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
                best_meta = {
                    "max_dim": max_dim,
                    "quality": quality,
                    "width": candidate.width,
                    "height": candidate.height,
                }

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
        "method": "pillow_image",
        "original_size": original_size,
        "compressed_size": compressed_size,
        "improved": compressed_size < original_size,
        "output_path": str(output_path),
        **best_meta,
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
                    img.save(buf, format="JPEG", quality=45, optimize=True, progressive=True)
                    data = buf.getvalue()

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


def structural_pdf_compress(input_path: Path, output_path: Path) -> dict:
    from pypdf import PdfReader, PdfWriter

    original_size = file_size(input_path)

    try:
        reader = PdfReader(str(input_path), strict=False)
        changed_images = recompress_pdf_images(reader)

        writer = PdfWriter()
        for page in reader.pages:
            writer.add_page(page)

        try:
            writer.add_metadata({})
        except Exception:
            pass

        with open(output_path, "wb") as fh:
            writer.write(fh)

        compressed_size = file_size(output_path)

        if not compressed_size:
            shutil.copyfile(input_path, output_path)
            compressed_size = file_size(output_path)

        if compressed_size > original_size:
            shutil.copyfile(input_path, output_path)
            compressed_size = file_size(output_path)

        return {
            "ok": True,
            "method": "pypdf_structural",
            "original_size": original_size,
            "compressed_size": compressed_size,
            "improved": compressed_size < original_size,
            "changed_images": changed_images,
            "output_path": str(output_path),
        }
    except Exception as exc:
        shutil.copyfile(input_path, output_path)
        return {
            "ok": False,
            "method": "pypdf_structural",
            "original_size": original_size,
            "compressed_size": file_size(output_path),
            "improved": False,
            "output_path": str(output_path),
            "warning": str(exc),
        }


def render_pdf_to_images(input_path: Path, scale: float, quality: int, max_pages: int = 30) -> list[Path]:
    import pypdfium2 as pdfium
    from PIL import Image

    pdf = pdfium.PdfDocument(str(input_path))
    page_count = len(pdf)
    if page_count > max_pages:
        raise RuntimeError(f"El PDF tiene {page_count} páginas; máximo soportado para compresión rápida: {max_pages}.")

    temp_dir = Path(tempfile.mkdtemp(prefix="ship_pdf_pages_"))
    images: list[Path] = []

    try:
        for i in range(page_count):
            page = pdf[i]
            bitmap = page.render(scale=scale, rotation=0)
            pil_image = bitmap.to_pil()

            if pil_image.mode not in ("RGB", "L"):
                pil_image = pil_image.convert("RGB")
            elif pil_image.mode == "L":
                pil_image = pil_image.convert("RGB")

            image_path = temp_dir / f"page_{i:04d}.jpg"
            pil_image.save(
                image_path,
                "JPEG",
                quality=quality,
                optimize=True,
                progressive=True,
                dpi=(110, 110),
            )
            images.append(image_path)

            try:
                pil_image.close()
            except Exception:
                pass
            try:
                page.close()
            except Exception:
                pass
    finally:
        try:
            pdf.close()
        except Exception:
            pass

    return images


def images_to_pdf(image_paths: list[Path], output_path: Path) -> None:
    from PIL import Image

    opened = []
    try:
        for path in image_paths:
            img = Image.open(path)
            if img.mode != "RGB":
                img = img.convert("RGB")
            opened.append(img)

        if not opened:
            raise RuntimeError("No se generaron imágenes para reconstruir PDF.")

        first, rest = opened[0], opened[1:]
        first.save(
            output_path,
            "PDF",
            save_all=True,
            append_images=rest,
            resolution=110.0,
            quality=65,
            optimize=True,
        )
    finally:
        for img in opened:
            try:
                img.close()
            except Exception:
                pass


def cleanup_rendered_images(image_paths: list[Path]) -> None:
    parent = image_paths[0].parent if image_paths else None
    for path in image_paths:
        try:
            path.unlink()
        except Exception:
            pass
    if parent:
        try:
            parent.rmdir()
        except Exception:
            pass


def raster_pdf_compress(input_path: Path, output_path: Path, target_bytes: int) -> dict:
    original_size = file_size(input_path)
    best_bytes = None
    best_meta = None

    # These attempts sacrifice fidelity gradually. Useful for scanned statements.
    attempts = [
        (1.50, 58),
        (1.25, 52),
        (1.05, 46),
        (0.90, 40),
        (0.78, 35),
        (0.66, 30),
    ]

    for scale, quality in attempts:
        tmp_pdf = output_path.with_suffix(f".raster_{str(scale).replace('.', '_')}_{quality}.pdf")
        image_paths: list[Path] = []
        try:
            image_paths = render_pdf_to_images(input_path, scale=scale, quality=quality)
            images_to_pdf(image_paths, tmp_pdf)
            data = tmp_pdf.read_bytes()
            size = len(data)

            if best_bytes is None or size < len(best_bytes):
                best_bytes = data
                best_meta = {
                    "scale": scale,
                    "quality": quality,
                    "pages": len(image_paths),
                    "candidate_size": size,
                }

            if size <= target_bytes:
                break
        except Exception as exc:
            if best_meta is None:
                best_meta = {"warning": str(exc)}
        finally:
            cleanup_rendered_images(image_paths)
            try:
                if tmp_pdf.exists():
                    tmp_pdf.unlink()
            except Exception:
                pass

    if best_bytes:
        output_path.write_bytes(best_bytes)
    else:
        shutil.copyfile(input_path, output_path)

    compressed_size = file_size(output_path)
    return {
        "ok": True,
        "type": "pdf",
        "method": "pypdfium2_raster",
        "original_size": original_size,
        "compressed_size": compressed_size,
        "improved": compressed_size < original_size,
        "output_path": str(output_path),
        **(best_meta or {}),
        "note": "PDF rasterizado y reconstruido como PDF de imágenes comprimidas.",
    }


def compress_pdf(input_path: Path, output_path: Path, target_bytes: int) -> dict:
    original_size = file_size(input_path)

    structural_path = output_path.with_suffix(".structural.pdf")
    structural = structural_pdf_compress(input_path, structural_path)
    structural_size = file_size(structural_path)

    # If structural compression already works, use it.
    if structural_size and structural_size <= target_bytes and structural_size < original_size:
        shutil.move(str(structural_path), output_path)
        structural["output_path"] = str(output_path)
        structural["type"] = "pdf"
        return structural

    raster_path = output_path.with_suffix(".raster.pdf")
    raster = raster_pdf_compress(input_path, raster_path, target_bytes)
    raster_size = file_size(raster_path)

    candidates = []
    if structural_size:
        candidates.append(("pypdf_structural", structural_path, structural_size, structural))
    if raster_size:
        candidates.append(("pypdfium2_raster", raster_path, raster_size, raster))

    if not candidates:
        shutil.copyfile(input_path, output_path)
        return {
            "ok": True,
            "type": "pdf",
            "method": "original_copy",
            "original_size": original_size,
            "compressed_size": file_size(output_path),
            "improved": False,
            "output_path": str(output_path),
        }

    # Prefer any candidate under target, otherwise choose smallest candidate.
    under_target = [x for x in candidates if x[2] <= target_bytes]
    chosen = min(under_target or candidates, key=lambda x: x[2])
    method, chosen_path, chosen_size, chosen_info = chosen

    if chosen_size < original_size:
        shutil.copyfile(chosen_path, output_path)
    else:
        shutil.copyfile(input_path, output_path)
        method = "original_copy"

    for path in [structural_path, raster_path]:
        try:
            if path.exists():
                path.unlink()
        except Exception:
            pass

    compressed_size = file_size(output_path)
    return {
        "ok": True,
        "type": "pdf",
        "method": method,
        "original_size": original_size,
        "compressed_size": compressed_size,
        "improved": compressed_size < original_size,
        "output_path": str(output_path),
        "structural_size": structural_size,
        "raster_size": raster_size,
        "note": chosen_info.get("note") or "Best-effort PDF compression.",
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
