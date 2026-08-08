"""Deterministic JSON Resume → Career Graph proposal mapping."""

from __future__ import annotations

import hashlib
import re
from typing import Any


def _slug(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-")
    return normalized[:28] or "item"


def _stable_id(prefix: str, anchor: str) -> str:
    digest = hashlib.sha256(anchor.encode("utf-8")).hexdigest()[:10]
    return f"{prefix}:{_slug(anchor)}-{digest}"


def _data(source: dict[str, Any], mapping: dict[str, str]) -> dict[str, Any]:
    return {
        target: source[source_key]
        for target, source_key in mapping.items()
        if source.get(source_key) not in (None, "", [])
    }


def _node(
    node_id: str,
    node_type: str,
    data: dict[str, Any],
    source_ref: str,
) -> dict[str, Any]:
    return {
        "id": node_id,
        "type": node_type,
        "data": data,
        "provenance": {
            "source_type": "resume_import",
            "source_ref": source_ref,
        },
    }


def _edge(edge_type: str, from_id: str, to_id: str) -> dict[str, str]:
    return {
        "id": _stable_id("edge", f"{edge_type}|{from_id}|{to_id}"),
        "from": from_id,
        "to": to_id,
        "type": edge_type,
    }


def json_resume_to_operations(
    resume: dict[str, Any],
    *,
    source_ref: str,
) -> dict[str, Any]:
    """Return upsert-only graph operations and an import report.

    Re-importing the same résumé is idempotent because IDs derive from stable
    anchors. Missing sections never generate removals.
    """

    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, str]] = []
    warnings: list[str] = []

    basics = resume.get("basics")
    person_id: str | None = None
    if isinstance(basics, dict) and basics:
        person_data = _data(
            basics,
            {
                "name": "name",
                "email": "email",
                "phone": "phone",
                "url": "url",
                "summary": "summary",
                "location": "location",
            },
        )
        if person_data:
            person_anchor = str(person_data.get("email") or person_data.get("name") or source_ref)
            person_id = _stable_id("person", person_anchor)
            nodes.append(_node(person_id, "person", person_data, source_ref))

    work = resume.get("work")
    if isinstance(work, list):
        for work_index, item in enumerate(work):
            if not isinstance(item, dict):
                warnings.append(f"work[{work_index}] ignored: expected object")
                continue
            role_data = _data(
                item,
                {
                    "organization": "name",
                    "position": "position",
                    "start_date": "startDate",
                    "end_date": "endDate",
                    "location": "location",
                    "summary": "summary",
                    "url": "url",
                },
            )
            role_anchor = (
                "|".join(
                    str(role_data.get(key, ""))
                    for key in ("organization", "position", "start_date")
                )
                or f"{source_ref}|work|{work_index}"
            )
            role_id = _stable_id("role", role_anchor)
            nodes.append(_node(role_id, "role", role_data, source_ref))
            if person_id:
                edges.append(_edge("held_role", person_id, role_id))

            highlights = item.get("highlights")
            if isinstance(highlights, list):
                for highlight_index, text in enumerate(highlights):
                    if not isinstance(text, str) or not text.strip():
                        warnings.append(
                            f"work[{work_index}].highlights[{highlight_index}] ignored: "
                            "expected non-empty text"
                        )
                        continue
                    achievement_id = _stable_id(
                        "achievement",
                        f"{role_id}|{text.strip()}",
                    )
                    nodes.append(
                        _node(
                            achievement_id,
                            "achievement",
                            {"text": text.strip()},
                            source_ref,
                        )
                    )
                    edges.append(_edge("includes", role_id, achievement_id))

    projects = resume.get("projects")
    if isinstance(projects, list):
        for index, item in enumerate(projects):
            if not isinstance(item, dict):
                warnings.append(f"projects[{index}] ignored: expected object")
                continue
            project_data = _data(
                item,
                {
                    "name": "name",
                    "description": "description",
                    "start_date": "startDate",
                    "end_date": "endDate",
                    "url": "url",
                    "highlights": "highlights",
                    "keywords": "keywords",
                },
            )
            project_id = _stable_id(
                "project",
                f"{project_data.get('name', '')}|{project_data.get('start_date', '')}|{index}",
            )
            nodes.append(_node(project_id, "project", project_data, source_ref))
            if person_id:
                edges.append(_edge("built_project", person_id, project_id))

    education = resume.get("education")
    if isinstance(education, list):
        for index, item in enumerate(education):
            if not isinstance(item, dict):
                warnings.append(f"education[{index}] ignored: expected object")
                continue
            education_data = _data(
                item,
                {
                    "institution": "institution",
                    "area": "area",
                    "study_type": "studyType",
                    "start_date": "startDate",
                    "end_date": "endDate",
                    "score": "score",
                    "url": "url",
                },
            )
            education_id = _stable_id(
                "education",
                f"{education_data.get('institution', '')}|{education_data.get('area', '')}|{index}",
            )
            nodes.append(_node(education_id, "education", education_data, source_ref))
            if person_id:
                edges.append(_edge("studied", person_id, education_id))

    skills = resume.get("skills")
    if isinstance(skills, list):
        for index, item in enumerate(skills):
            if isinstance(item, str):
                item = {"name": item}
            if not isinstance(item, dict) or not isinstance(item.get("name"), str):
                warnings.append(f"skills[{index}] ignored: expected name")
                continue
            skill_data = _data(
                item,
                {"name": "name", "level": "level", "keywords": "keywords"},
            )
            skill_id = _stable_id("skill", skill_data["name"])
            nodes.append(_node(skill_id, "skill", skill_data, source_ref))

    certificates = resume.get("certificates")
    if isinstance(certificates, list):
        for index, item in enumerate(certificates):
            if not isinstance(item, dict):
                warnings.append(f"certificates[{index}] ignored: expected object")
                continue
            certificate_data = _data(
                item,
                {"name": "name", "date": "date", "issuer": "issuer", "url": "url"},
            )
            certificate_id = _stable_id(
                "certification",
                f"{certificate_data.get('name', '')}|{certificate_data.get('issuer', '')}|{index}",
            )
            nodes.append(_node(certificate_id, "certification", certificate_data, source_ref))
            if person_id:
                edges.append(_edge("earned", person_id, certificate_id))

    languages = resume.get("languages")
    if isinstance(languages, list):
        for index, item in enumerate(languages):
            if not isinstance(item, dict) or not item.get("language"):
                warnings.append(f"languages[{index}] ignored: expected language")
                continue
            language_data = _data(
                item,
                {"language": "language", "fluency": "fluency"},
            )
            language_id = _stable_id("language", language_data["language"])
            nodes.append(_node(language_id, "language", language_data, source_ref))
            if person_id:
                edges.append(_edge("speaks", person_id, language_id))

    operations = [
        *({"op": "upsert_node", "node": node} for node in nodes),
        *({"op": "upsert_edge", "edge": edge} for edge in edges),
    ]
    return {
        "operations": operations,
        "report": {
            "source_ref": source_ref,
            "node_count": len(nodes),
            "edge_count": len(edges),
            "warnings": warnings,
            "upsert_only": True,
        },
    }
