#!/usr/bin/env python3
"""Build Relay's deterministic Pandoc reference DOCX files."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from docx import Document
from docx.enum.style import WD_STYLE_TYPE
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Mm, Pt, RGBColor

ROOT = Path(__file__).resolve().parents[1]
ASSET_DIR = ROOT / "api" / "assets"
FIXED_TIME = datetime(2025, 1, 1, tzinfo=timezone.utc)
ZIP_TIME = (2025, 1, 1, 0, 0, 0)

PROFILES = {
    "one_page": {
        "body_size": 9.5,
        "body_line": 1.2,
        "name_size": 20,
        "section_size": 10.25,
        "role_size": 9.75,
        "section_before_mm": 2.8,
        "paragraph_after_mm": 0.9,
        "bullet_after_mm": 0.45,
    },
    "two_page": {
        "body_size": 10.5,
        "body_line": 1.28,
        "name_size": 21,
        "section_size": 11,
        "role_size": 10.5,
        "section_before_mm": 4.2,
        "paragraph_after_mm": 1.3,
        "bullet_after_mm": 0.8,
    },
}


def _set_font(style, *, size: float, bold: bool | None = None) -> None:
    style.font.name = "Arial"
    style.font.size = Pt(size)
    if bold is not None:
        style.font.bold = bold
    style.font.color.rgb = RGBColor(0x11, 0x11, 0x11)
    r_pr = style.element.get_or_add_rPr()
    r_fonts = r_pr.get_or_add_rFonts()
    for attribute, value in (
        ("ascii", "Arial"),
        ("hAnsi", "Arial"),
        ("cs", "Arial"),
        ("eastAsia", "Microsoft YaHei"),
    ):
        r_fonts.set(qn(f"w:{attribute}"), value)


def _set_paragraph_spacing(
    style,
    *,
    before_mm: float = 0,
    after_mm: float = 0,
    line_spacing: float | None = None,
    keep_with_next: bool | None = None,
    keep_together: bool | None = None,
) -> None:
    paragraph = style.paragraph_format
    paragraph.space_before = Mm(before_mm)
    paragraph.space_after = Mm(after_mm)
    if line_spacing is not None:
        paragraph.line_spacing = line_spacing
    if keep_with_next is not None:
        paragraph.keep_with_next = keep_with_next
    if keep_together is not None:
        paragraph.keep_together = keep_together
    paragraph.widow_control = True


def _set_bottom_border(style) -> None:
    p_pr = style.element.get_or_add_pPr()
    borders = p_pr.find(qn("w:pBdr"))
    if borders is None:
        borders = OxmlElement("w:pBdr")
        p_pr.append(borders)
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), "4")
    bottom.set(qn("w:space"), "2")
    bottom.set(qn("w:color"), "777777")
    borders.append(bottom)


def _configure_styles(document: Document, profile: dict[str, float]) -> None:
    body_style_names = ("Normal", "Body Text", "First Paragraph")
    for style_name in body_style_names:
        style = document.styles[style_name]
        _set_font(style, size=profile["body_size"])
        _set_paragraph_spacing(
            style,
            after_mm=profile["paragraph_after_mm"],
            line_spacing=profile["body_line"],
        )

    heading_1 = document.styles["Heading 1"]
    _set_font(heading_1, size=profile["name_size"], bold=True)
    _set_paragraph_spacing(
        heading_1,
        after_mm=1.5,
        line_spacing=1.05,
        keep_with_next=True,
        keep_together=True,
    )
    heading_1.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.LEFT

    heading_2 = document.styles["Heading 2"]
    _set_font(heading_2, size=profile["section_size"], bold=True)
    _set_paragraph_spacing(
        heading_2,
        before_mm=profile["section_before_mm"],
        after_mm=1.8,
        line_spacing=1.1,
        keep_with_next=True,
        keep_together=True,
    )
    heading_2.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.LEFT
    _set_bottom_border(heading_2)

    heading_3 = document.styles["Heading 3"]
    _set_font(heading_3, size=profile["role_size"], bold=True)
    _set_paragraph_spacing(
        heading_3,
        before_mm=2.2,
        after_mm=0.5,
        line_spacing=1.15,
        keep_with_next=True,
        keep_together=True,
    )
    heading_3.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.LEFT

    # Pandoc applies Compact plus numbering.xml to list paragraphs.
    compact = document.styles["Compact"]
    _set_font(compact, size=profile["body_size"])
    _set_paragraph_spacing(
        compact,
        after_mm=profile["bullet_after_mm"],
        line_spacing=profile["body_line"],
        keep_together=True,
    )
    compact.paragraph_format.left_indent = Mm(4.8)
    compact.paragraph_format.first_line_indent = Mm(-2.2)

    hyperlink = document.styles["Hyperlink"]
    _set_font(hyperlink, size=profile["body_size"])
    hyperlink.font.underline = False

    # Pandoc may emit an Image Caption style even though Relay drops images.
    image_caption = document.styles["Image Caption"]
    _set_font(image_caption, size=profile["body_size"])

    # Explicitly remove Word theme-driven fonts from every paragraph style.
    for style in document.styles:
        if style.type != WD_STYLE_TYPE.PARAGRAPH:
            continue
        r_pr = style.element.get_or_add_rPr()
        r_fonts = r_pr.get_or_add_rFonts()
        for attribute in ("asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme"):
            r_fonts.attrib.pop(qn(f"w:{attribute}"), None)

    # Pandoc uses the reference package's list definitions. Collapse its
    # default half-inch bullet indent to Relay's compact 4.8 mm profile.
    numbering = document.part.numbering_part.element
    for level in numbering.findall(qn("w:abstractNum") + "/" + qn("w:lvl")):
        if level.get(qn("w:ilvl")) != "0":
            continue
        paragraph_properties = level.find(qn("w:pPr"))
        if paragraph_properties is None:
            paragraph_properties = OxmlElement("w:pPr")
            level.append(paragraph_properties)
        indentation = paragraph_properties.find(qn("w:ind"))
        if indentation is None:
            indentation = OxmlElement("w:ind")
            paragraph_properties.append(indentation)
        indentation.set(qn("w:left"), "272")
        indentation.set(qn("w:hanging"), "125")


def _configure_document(document: Document, profile_name: str) -> None:
    for section in document.sections:
        section.page_width = Mm(210)
        section.page_height = Mm(297)
        section.top_margin = Mm(12)
        section.right_margin = Mm(14)
        section.bottom_margin = Mm(12)
        section.left_margin = Mm(14)
        section.header_distance = Mm(4)
        section.footer_distance = Mm(4)
        section.gutter = Mm(0)

    properties = document.core_properties
    properties.title = f"Relay ATS résumé reference — {profile_name}"
    properties.subject = "Deterministic Pandoc reference document"
    properties.author = "Relay"
    properties.last_modified_by = "Relay"
    properties.comments = "Generated by scripts/build-resume-reference-docx.py"
    properties.created = FIXED_TIME
    properties.modified = FIXED_TIME


def _normalize_zip(source: Path, destination: Path) -> None:
    with ZipFile(source, "r") as archive_in, ZipFile(
        destination,
        "w",
        compression=ZIP_DEFLATED,
        compresslevel=9,
    ) as archive_out:
        for name in sorted(archive_in.namelist()):
            original = archive_in.getinfo(name)
            info = ZipInfo(filename=name, date_time=ZIP_TIME)
            info.compress_type = ZIP_DEFLATED
            info.external_attr = original.external_attr
            info.create_system = original.create_system
            archive_out.writestr(info, archive_in.read(name))


def build_reference(profile_name: str, destination: Path) -> None:
    if shutil.which("pandoc") is None:
        raise RuntimeError("pandoc is required to build reference DOCX assets")

    with tempfile.TemporaryDirectory(prefix="relay-reference-docx-") as tmp:
        tmp_dir = Path(tmp)
        base = tmp_dir / "pandoc-reference.docx"
        styled = tmp_dir / "styled.docx"
        subprocess.run(
            [
                "pandoc",
                "-o",
                str(base),
                "--print-default-data-file",
                "reference.docx",
            ],
            check=True,
        )
        document = Document(base)
        _configure_document(document, profile_name)
        _configure_styles(document, PROFILES[profile_name])
        document.save(styled)
        _normalize_zip(styled, destination)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail when committed assets differ from a clean rebuild.",
    )
    args = parser.parse_args()

    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="relay-reference-check-") as tmp:
        output_dir = Path(tmp) if args.check else ASSET_DIR
        for profile_name in PROFILES:
            destination = output_dir / f"resume-reference-{profile_name}.docx"
            build_reference(profile_name, destination)
            if args.check:
                committed = ASSET_DIR / destination.name
                if not committed.exists() or committed.read_bytes() != destination.read_bytes():
                    raise SystemExit(f"stale reference asset: {committed}")


if __name__ == "__main__":
    main()
