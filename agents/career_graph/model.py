"""Pure Career Graph validation, change application, and résumé compilation.

The graph is the source of truth. A compilation may select and order facts but
never invent or paraphrase them: every rendered field is copied from a graph
node and recorded in ``selection_manifest``.
"""

from __future__ import annotations

import copy
import math
import re
from datetime import date
from typing import Any

SCHEMA_VERSION = 1
COMPILER_PROFILE_VERSION = 1
QUALITY_TOKEN_SAMPLE_LIMIT = 100
ARTIFACT_LOCALES = {"en", "zh"}
LENGTH_BUDGETS = {
    "one_page": {
        "target_pages": 1,
        "max_roles": 4,
        "max_achievements_per_role": 3,
        "max_total_achievements": 6,
        "max_projects": 1,
        "max_skills": 10,
        "max_education": 2,
        "max_certificates": 3,
        "max_languages": 4,
    },
    "two_page": {
        "target_pages": 2,
        "max_roles": 8,
        "max_achievements_per_role": 4,
        "max_total_achievements": 12,
        "max_projects": 3,
        "max_skills": 18,
        "max_education": 4,
        "max_certificates": 6,
        "max_languages": 6,
    },
}
ATS_PROFILES = {"standard", "strict"}
NODE_TYPES = {
    "person",
    "role",
    "achievement",
    "project",
    "education",
    "skill",
    "certification",
    "language",
}
EDGE_TYPES = {
    "held_role",
    "includes",
    "delivered",
    "demonstrates",
    "used_skill",
    "built_project",
    "studied",
    "earned",
    "speaks",
}
PROVENANCE_TYPES = {
    "user_asserted",
    "resume_import",
    "document",
    "application_feedback",
}


class GraphValidationError(ValueError):
    """Raised when a graph snapshot or operation violates the graph contract."""

    def __init__(self, errors: list[str]) -> None:
        super().__init__("; ".join(errors))
        self.errors = errors


def empty_snapshot() -> dict[str, Any]:
    """Return a valid, empty Career Graph snapshot."""

    return {"schema_version": SCHEMA_VERSION, "nodes": [], "edges": []}


def validate_snapshot(snapshot: Any) -> list[str]:
    """Return validation errors without mutating ``snapshot``."""

    errors: list[str] = []
    if not isinstance(snapshot, dict):
        return ["snapshot must be an object"]
    if snapshot.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"schema_version must be {SCHEMA_VERSION}")

    nodes = snapshot.get("nodes")
    edges = snapshot.get("edges")
    if not isinstance(nodes, list):
        errors.append("nodes must be an array")
        nodes = []
    if not isinstance(edges, list):
        errors.append("edges must be an array")
        edges = []

    node_ids: set[str] = set()
    for index, node in enumerate(nodes):
        prefix = f"nodes[{index}]"
        if not isinstance(node, dict):
            errors.append(f"{prefix} must be an object")
            continue
        node_id = node.get("id")
        node_type = node.get("type")
        data = node.get("data")
        provenance = node.get("provenance")
        if not isinstance(node_id, str) or not node_id.strip():
            errors.append(f"{prefix}.id must be a non-empty string")
        elif node_id in node_ids:
            errors.append(f"duplicate node id: {node_id}")
        else:
            node_ids.add(node_id)
        if node_type not in NODE_TYPES:
            errors.append(f"{prefix}.type must be one of {sorted(NODE_TYPES)}")
        if not isinstance(data, dict):
            errors.append(f"{prefix}.data must be an object")
        if not isinstance(provenance, dict):
            errors.append(f"{prefix}.provenance must be an object")
        else:
            if provenance.get("source_type") not in PROVENANCE_TYPES:
                errors.append(
                    f"{prefix}.provenance.source_type must be one of {sorted(PROVENANCE_TYPES)}"
                )
            source_ref = provenance.get("source_ref")
            if not isinstance(source_ref, str) or not source_ref.strip():
                errors.append(f"{prefix}.provenance.source_ref must be a non-empty string")

    edge_ids: set[str] = set()
    for index, edge in enumerate(edges):
        prefix = f"edges[{index}]"
        if not isinstance(edge, dict):
            errors.append(f"{prefix} must be an object")
            continue
        edge_id = edge.get("id")
        from_id = edge.get("from")
        to_id = edge.get("to")
        if not isinstance(edge_id, str) or not edge_id.strip():
            errors.append(f"{prefix}.id must be a non-empty string")
        elif edge_id in edge_ids:
            errors.append(f"duplicate edge id: {edge_id}")
        else:
            edge_ids.add(edge_id)
        if edge.get("type") not in EDGE_TYPES:
            errors.append(f"{prefix}.type must be one of {sorted(EDGE_TYPES)}")
        if from_id not in node_ids:
            errors.append(f"{prefix}.from references missing node: {from_id}")
        if to_id not in node_ids:
            errors.append(f"{prefix}.to references missing node: {to_id}")
        if from_id == to_id:
            errors.append(f"{prefix} cannot connect a node to itself")

    return errors


def require_valid_snapshot(snapshot: dict[str, Any]) -> None:
    errors = validate_snapshot(snapshot)
    if errors:
        raise GraphValidationError(errors)


def apply_operations(
    snapshot: dict[str, Any],
    operations: list[dict[str, Any]],
) -> dict[str, Any]:
    """Apply a small, explicit graph operation set and validate the result.

    Supported operations are ``upsert_node``, ``remove_node``,
    ``upsert_edge``, and ``remove_edge``. Removing a node also removes its
    incident edges. The input snapshot is never modified.
    """

    require_valid_snapshot(snapshot)
    result = copy.deepcopy(snapshot)
    nodes = {node["id"]: node for node in result["nodes"]}
    edges = {edge["id"]: edge for edge in result["edges"]}

    for index, operation in enumerate(operations):
        if not isinstance(operation, dict):
            raise GraphValidationError([f"operations[{index}] must be an object"])
        op = operation.get("op")
        if op == "upsert_node":
            node = operation.get("node")
            if not isinstance(node, dict) or not isinstance(node.get("id"), str):
                raise GraphValidationError([f"operations[{index}].node must contain a string id"])
            nodes[node["id"]] = copy.deepcopy(node)
        elif op == "remove_node":
            node_id = operation.get("node_id")
            if not isinstance(node_id, str):
                raise GraphValidationError([f"operations[{index}].node_id must be a string"])
            nodes.pop(node_id, None)
            edges = {
                edge_id: edge
                for edge_id, edge in edges.items()
                if edge.get("from") != node_id and edge.get("to") != node_id
            }
        elif op == "upsert_edge":
            edge = operation.get("edge")
            if not isinstance(edge, dict) or not isinstance(edge.get("id"), str):
                raise GraphValidationError([f"operations[{index}].edge must contain a string id"])
            edges[edge["id"]] = copy.deepcopy(edge)
        elif op == "remove_edge":
            edge_id = operation.get("edge_id")
            if not isinstance(edge_id, str):
                raise GraphValidationError([f"operations[{index}].edge_id must be a string"])
            edges.pop(edge_id, None)
        else:
            raise GraphValidationError(
                [
                    f"operations[{index}].op must be one of "
                    "upsert_node, remove_node, upsert_edge, remove_edge"
                ]
            )

    result["nodes"] = list(nodes.values())
    result["edges"] = list(edges.values())
    require_valid_snapshot(result)
    return result


def summarize_snapshot_changes(
    before: dict[str, Any],
    after: dict[str, Any],
) -> dict[str, Any]:
    """Return a stable, review-friendly node/edge diff between two snapshots."""

    require_valid_snapshot(before)
    require_valid_snapshot(after)

    def entity_changes(
        entity: str,
        before_items: list[dict[str, Any]],
        after_items: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        before_by_id = {item["id"]: item for item in before_items}
        after_by_id = {item["id"]: item for item in after_items}
        changes: list[dict[str, Any]] = []
        for entity_id in sorted(before_by_id.keys() | after_by_id.keys()):
            previous = before_by_id.get(entity_id)
            proposed = after_by_id.get(entity_id)
            if previous == proposed:
                continue
            if previous is None:
                change = "added"
            elif proposed is None:
                change = "removed"
            else:
                change = "updated"
            changes.append(
                {
                    "entity": entity,
                    "id": entity_id,
                    "change": change,
                    "before": copy.deepcopy(previous),
                    "after": copy.deepcopy(proposed),
                }
            )
        return changes

    node_changes = entity_changes("node", before["nodes"], after["nodes"])
    edge_changes = entity_changes("edge", before["edges"], after["edges"])
    counts = {
        "added_nodes": sum(item["change"] == "added" for item in node_changes),
        "updated_nodes": sum(item["change"] == "updated" for item in node_changes),
        "removed_nodes": sum(item["change"] == "removed" for item in node_changes),
        "added_edges": sum(item["change"] == "added" for item in edge_changes),
        "updated_edges": sum(item["change"] == "updated" for item in edge_changes),
        "removed_edges": sum(item["change"] == "removed" for item in edge_changes),
    }
    return {
        "counts": counts,
        "total_changes": sum(counts.values()),
        "destructive": counts["removed_nodes"] > 0 or counts["removed_edges"] > 0,
        "nodes": node_changes,
        "edges": edge_changes,
    }


_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9+#.\-]{1,}|[\u4e00-\u9fff]{2,}")
_STOP_TOKENS = {
    "a",
    "an",
    "and",
    "are",
    "be",
    "for",
    "from",
    "have",
    "in",
    "is",
    "must",
    "of",
    "on",
    "or",
    "the",
    "to",
    "with",
}


def _tokens(value: str) -> set[str]:
    return {
        normalized
        for token in _TOKEN_RE.findall(value)
        if (normalized := token.casefold().strip(".-")) and normalized not in _STOP_TOKENS
    }


def _date_sort_key(value: Any) -> tuple[int, int]:
    if not isinstance(value, str) or not value:
        return (0, 0)
    if value.casefold() in {"present", "current", "至今"}:
        today = date.today()
        return (today.year + 1, today.month)
    match = re.match(r"^(\d{4})(?:-(\d{1,2}))?", value)
    if not match:
        return (0, 0)
    return (int(match.group(1)), int(match.group(2) or 1))


def _data_text(node: dict[str, Any]) -> str:
    values: list[str] = []
    for value in node.get("data", {}).values():
        if isinstance(value, str):
            values.append(value)
        elif isinstance(value, list):
            values.extend(str(item) for item in value if isinstance(item, (str, int, float)))
    return " ".join(values)


def normalize_compiler_config(
    *,
    artifact_locale: str = "en",
    length_budget: str = "two_page",
    ats_profile: str = "standard",
    max_achievements_per_role: int | None = None,
) -> dict[str, Any]:
    """Resolve a reproducible compiler profile and validate every override."""

    if artifact_locale not in ARTIFACT_LOCALES:
        raise ValueError(f"artifact_locale must be one of {sorted(ARTIFACT_LOCALES)}")
    if length_budget not in LENGTH_BUDGETS:
        raise ValueError(f"length_budget must be one of {sorted(LENGTH_BUDGETS)}")
    if ats_profile not in ATS_PROFILES:
        raise ValueError(f"ats_profile must be one of {sorted(ATS_PROFILES)}")
    if max_achievements_per_role is not None and (
        isinstance(max_achievements_per_role, bool)
        or not isinstance(max_achievements_per_role, int)
        or not 1 <= max_achievements_per_role <= 8
    ):
        raise ValueError("max_achievements_per_role must be between 1 and 8")

    config = {
        "profile_version": COMPILER_PROFILE_VERSION,
        "artifact_locale": artifact_locale,
        "length_budget": length_budget,
        "ats_profile": ats_profile,
        **copy.deepcopy(LENGTH_BUDGETS[length_budget]),
    }
    if max_achievements_per_role is not None:
        config["max_achievements_per_role"] = max_achievements_per_role
    return config


def _scalar_text(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return [str(value)]
    if isinstance(value, list):
        return [part for item in value for part in _scalar_text(item)]
    if isinstance(value, dict):
        return [part for item in value.values() for part in _scalar_text(item)]
    return []


def _compilation_quality_report(
    resume: dict[str, Any],
    *,
    nodes: dict[str, dict[str, Any]],
    selected_node_ids: set[str],
    jd_tokens: set[str],
    compiler_config: dict[str, Any],
) -> dict[str, Any]:
    """Describe ATS and length quality without inventing or rewriting content."""

    basics_value = resume.get("basics")
    work_value = resume.get("work")
    projects_value = resume.get("projects")
    skills_value = resume.get("skills")
    basics: dict[str, Any] = basics_value if isinstance(basics_value, dict) else {}
    work: list[Any] = work_value if isinstance(work_value, list) else []
    projects: list[Any] = projects_value if isinstance(projects_value, list) else []
    skills: list[Any] = skills_value if isinstance(skills_value, list) else []
    highlights: list[str] = []
    for item in work:
        if not isinstance(item, dict):
            continue
        item_highlights = item.get("highlights")
        if isinstance(item_highlights, list):
            highlights.extend(
                highlight for highlight in item_highlights if isinstance(highlight, str)
            )

    def non_empty_string(value: Any) -> bool:
        return isinstance(value, str) and bool(value.strip())

    checks = [
        {
            "id": "has_name",
            "passed": non_empty_string(basics.get("name")),
            "message": "A candidate name is present.",
        },
        {
            "id": "has_contact_method",
            "passed": any(
                non_empty_string(basics.get(field)) for field in ("email", "phone", "url")
            ),
            "message": "At least one direct contact method is present.",
        },
        {
            "id": "has_experience_evidence",
            "passed": bool(work or projects),
            "message": "At least one work or project section is present.",
        },
    ]
    if compiler_config["ats_profile"] == "strict":
        checks.extend(
            [
                {
                    "id": "has_email",
                    "passed": non_empty_string(basics.get("email")),
                    "message": "Strict ATS profile expects an email address.",
                },
                {
                    "id": "work_dates_present",
                    "passed": all(
                        isinstance(item, dict)
                        and bool(item.get("startDate"))
                        and bool(item.get("endDate"))
                        for item in work
                    ),
                    "message": "Strict ATS profile expects start and end dates for every role.",
                },
                {
                    "id": "highlight_length",
                    "passed": all(len(highlight) <= 240 for highlight in highlights),
                    "message": "Strict ATS profile flags achievement bullets over 240 characters.",
                },
            ]
        )

    rendered_text = " ".join(_scalar_text(resume))
    rendered_tokens = _tokens(rendered_text)
    matched_tokens = sorted(jd_tokens & rendered_tokens)
    unmatched_tokens = sorted(jd_tokens - rendered_tokens)
    character_count = len(rendered_text)
    characters_per_page = 2000 if compiler_config["artifact_locale"] == "zh" else 3500
    estimated_pages = (
        max(1, math.ceil(character_count / characters_per_page)) if character_count else 0
    )
    within_length_budget = estimated_pages <= int(compiler_config["target_pages"])
    failed_checks = [check for check in checks if not check["passed"]]
    warnings = [check["message"] for check in failed_checks]
    if not within_length_budget:
        warnings.append(
            f"Estimated {estimated_pages} pages exceeds the "
            f"{compiler_config['target_pages']}-page budget."
        )

    omitted_node_ids = sorted(set(nodes) - selected_node_ids)
    return {
        "profile_version": COMPILER_PROFILE_VERSION,
        "quality_status": (
            "ready_for_human_review"
            if not failed_checks and within_length_budget
            else "needs_human_attention"
        ),
        "artifact_locale": compiler_config["artifact_locale"],
        "artifact_locale_behavior": "structural_labels_only_source_facts_unchanged",
        "length": {
            "budget": compiler_config["length_budget"],
            "target_pages": compiler_config["target_pages"],
            "estimated_pages": estimated_pages,
            "estimated_content_characters": character_count,
            "characters_per_page_estimate": characters_per_page,
            "estimate_only": True,
            "within_budget": within_length_budget,
        },
        "ats": {
            "profile": compiler_config["ats_profile"],
            "ready": not failed_checks,
            "checks": checks,
        },
        "jd_coverage": {
            "jd_token_count": len(jd_tokens),
            "matched_token_count": len(matched_tokens),
            "coverage_ratio": (
                round(len(matched_tokens) / len(jd_tokens), 4) if jd_tokens else 0.0
            ),
            "matched_tokens": matched_tokens[:QUALITY_TOKEN_SAMPLE_LIMIT],
            "matched_tokens_truncated": len(matched_tokens) > QUALITY_TOKEN_SAMPLE_LIMIT,
            "unmatched_tokens": unmatched_tokens[:QUALITY_TOKEN_SAMPLE_LIMIT],
            "unmatched_tokens_truncated": len(unmatched_tokens) > QUALITY_TOKEN_SAMPLE_LIMIT,
        },
        "selection": {
            "selected_node_count": len(selected_node_ids),
            "omitted_node_count": len(omitted_node_ids),
            "omitted_node_ids": omitted_node_ids,
            "role_count": len(work),
            "achievement_count": len(highlights),
            "project_count": len(projects),
            "skill_count": len(skills),
        },
        "warnings": warnings,
    }


def _related(
    node_id: str,
    edge_types: set[str],
    edges: list[dict[str, Any]],
    *,
    outgoing: bool = True,
) -> list[str]:
    related: list[str] = []
    for edge in edges:
        if edge.get("type") not in edge_types:
            continue
        if outgoing and edge.get("from") == node_id:
            related.append(edge["to"])
        elif not outgoing and edge.get("to") == node_id:
            related.append(edge["from"])
    return related


def compile_resume(
    snapshot: dict[str, Any],
    jd_text: str,
    *,
    artifact_locale: str = "en",
    length_budget: str = "two_page",
    ats_profile: str = "standard",
    max_achievements_per_role: int | None = None,
    evidence_ranking: dict[str, int] | None = None,
) -> dict[str, Any]:
    """Compile a JSON Resume document from graph facts for one JD.

    Matching affects selection and ordering only. No text is generated. The
    returned manifest proves which source node supplied every rendered block.
    """

    require_valid_snapshot(snapshot)
    compiler_config = normalize_compiler_config(
        artifact_locale=artifact_locale,
        length_budget=length_budget,
        ats_profile=ats_profile,
        max_achievements_per_role=max_achievements_per_role,
    )

    nodes = {node["id"]: node for node in snapshot["nodes"]}
    edges = snapshot["edges"]
    jd_tokens = _tokens(jd_text)
    ranking = evidence_ranking or {}
    manifest: dict[str, str | list[str]] = {}
    selected_node_ids: set[str] = set()

    person_nodes = [node for node in nodes.values() if node["type"] == "person"]
    person = person_nodes[0] if person_nodes else None
    basics: dict[str, Any] = {}
    if person:
        source = person["data"]
        field_map = {
            "name": "name",
            "email": "email",
            "phone": "phone",
            "url": "url",
            "summary": "summary",
            "location": "location",
        }
        for target, source_key in field_map.items():
            if source.get(source_key) not in (None, "", []):
                basics[target] = copy.deepcopy(source[source_key])
                manifest[f"basics.{target}"] = person["id"]
        if basics:
            selected_node_ids.add(person["id"])

    role_nodes = [node for node in nodes.values() if node["type"] == "role"]
    role_nodes.sort(
        key=lambda node: _date_sort_key(node.get("data", {}).get("start_date")),
        reverse=True,
    )
    role_nodes = role_nodes[: int(compiler_config["max_roles"])]
    remaining_achievement_budget = int(compiler_config["max_total_achievements"])
    work: list[dict[str, Any]] = []
    for role in role_nodes:
        data = role["data"]
        item: dict[str, Any] = {}
        role_fields = {
            "name": "organization",
            "position": "position",
            "startDate": "start_date",
            "endDate": "end_date",
            "location": "location",
            "summary": "summary",
            "url": "url",
        }
        work_index = len(work)
        for target, source_key in role_fields.items():
            if data.get(source_key) not in (None, "", []):
                item[target] = copy.deepcopy(data[source_key])
                manifest[f"work.{work_index}.{target}"] = role["id"]

        achievement_ids = _related(role["id"], {"includes", "delivered"}, edges, outgoing=True)
        achievement_ids.extend(
            _related(role["id"], {"includes", "delivered"}, edges, outgoing=False)
        )
        achievements = [
            nodes[node_id]
            for node_id in dict.fromkeys(achievement_ids)
            if node_id in nodes
            and nodes[node_id]["type"] == "achievement"
            and isinstance(nodes[node_id].get("data", {}).get("text"), str)
            and nodes[node_id]["data"]["text"].strip()
        ]
        achievement_order = {
            node_id: index for index, node_id in enumerate(dict.fromkeys(achievement_ids))
        }

        def achievement_score(
            node: dict[str, Any],
            order: dict[str, int] = achievement_order,
        ) -> tuple[int, int, int]:
            node_tokens = _tokens(_data_text(node))
            linked_skill_ids = _related(
                node["id"], {"demonstrates", "used_skill"}, edges, outgoing=True
            )
            for skill_id in linked_skill_ids:
                if skill_id in nodes:
                    node_tokens |= _tokens(_data_text(nodes[skill_id]))
            return (
                len(node_tokens & jd_tokens),
                ranking.get(node["id"], 0),
                -order[node["id"]],
            )

        achievements.sort(key=achievement_score, reverse=True)
        selected_achievements = achievements[
            : min(
                int(compiler_config["max_achievements_per_role"]),
                remaining_achievement_budget,
            )
        ]
        remaining_achievement_budget -= len(selected_achievements)
        highlights = [achievement["data"]["text"] for achievement in selected_achievements]
        if highlights:
            item["highlights"] = highlights
            source_ids = [achievement["id"] for achievement in selected_achievements]
            manifest[f"work.{work_index}.highlights"] = source_ids
            selected_node_ids.update(source_ids)
        if item:
            work.append(item)
            selected_node_ids.add(role["id"])

    education_nodes = [node for node in nodes.values() if node["type"] == "education"]
    education_nodes.sort(
        key=lambda node: _date_sort_key(node.get("data", {}).get("start_date")),
        reverse=True,
    )
    education: list[dict[str, Any]] = []
    for node in education_nodes[: int(compiler_config["max_education"])]:
        data = node["data"]
        education_item = {
            target: copy.deepcopy(data[source])
            for target, source in {
                "institution": "institution",
                "area": "area",
                "studyType": "study_type",
                "startDate": "start_date",
                "endDate": "end_date",
                "score": "score",
                "url": "url",
            }.items()
            if data.get(source) not in (None, "", [])
        }
        if education_item:
            index = len(education)
            education.append(education_item)
            manifest[f"education.{index}"] = node["id"]
            selected_node_ids.add(node["id"])

    project_nodes = [node for node in nodes.values() if node["type"] == "project"]
    project_nodes.sort(
        key=lambda node: (
            len(_tokens(_data_text(node)) & jd_tokens),
            ranking.get(node["id"], 0),
        ),
        reverse=True,
    )
    projects: list[dict[str, Any]] = []
    for node in project_nodes[: int(compiler_config["max_projects"])]:
        data = node["data"]
        project_item = {
            target: copy.deepcopy(data[source])
            for target, source in {
                "name": "name",
                "description": "description",
                "startDate": "start_date",
                "endDate": "end_date",
                "url": "url",
                "highlights": "highlights",
                "keywords": "keywords",
            }.items()
            if data.get(source) not in (None, "", [])
        }
        if project_item:
            index = len(projects)
            projects.append(project_item)
            manifest[f"projects.{index}"] = node["id"]
            selected_node_ids.add(node["id"])

    skill_nodes = [node for node in nodes.values() if node["type"] == "skill"]
    skill_nodes.sort(
        key=lambda node: (
            len(_tokens(_data_text(node)) & jd_tokens),
            ranking.get(node["id"], 0),
        ),
        reverse=True,
    )
    skills: list[dict[str, Any]] = []
    for node in skill_nodes[: int(compiler_config["max_skills"])]:
        data = node["data"]
        name = data.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        skill_item: dict[str, Any] = {"name": name}
        if data.get("level"):
            skill_item["level"] = data["level"]
        keywords = data.get("keywords")
        if isinstance(keywords, list) and keywords:
            skill_item["keywords"] = copy.deepcopy(keywords)
        index = len(skills)
        skills.append(skill_item)
        manifest[f"skills.{index}"] = node["id"]
        selected_node_ids.add(node["id"])

    certificates: list[dict[str, Any]] = []
    certificate_nodes = [node for node in nodes.values() if node["type"] == "certification"]
    for node in certificate_nodes[: int(compiler_config["max_certificates"])]:
        data = node["data"]
        certificate_item = {
            target: copy.deepcopy(data[source])
            for target, source in {
                "name": "name",
                "date": "date",
                "issuer": "issuer",
                "url": "url",
            }.items()
            if data.get(source) not in (None, "", [])
        }
        if certificate_item:
            index = len(certificates)
            certificates.append(certificate_item)
            manifest[f"certificates.{index}"] = node["id"]
            selected_node_ids.add(node["id"])

    languages: list[dict[str, Any]] = []
    language_nodes = [node for node in nodes.values() if node["type"] == "language"]
    for node in language_nodes[: int(compiler_config["max_languages"])]:
        data = node["data"]
        if not data.get("language"):
            continue
        language_item = {"language": data["language"]}
        if data.get("fluency"):
            language_item["fluency"] = data["fluency"]
        index = len(languages)
        languages.append(language_item)
        manifest[f"languages.{index}"] = node["id"]
        selected_node_ids.add(node["id"])

    resume: dict[str, Any] = {"basics": basics}
    for key, value in {
        "work": work,
        "education": education,
        "projects": projects,
        "skills": skills,
        "certificates": certificates,
        "languages": languages,
    }.items():
        if value:
            resume[key] = value

    quality_report = _compilation_quality_report(
        resume,
        nodes=nodes,
        selected_node_ids=selected_node_ids,
        jd_tokens=jd_tokens,
        compiler_config=compiler_config,
    )
    return {
        "resume": resume,
        "selection_manifest": manifest,
        "compiler_config": compiler_config,
        "quality_report": quality_report,
        "guard_report": {
            "source_only": True,
            "fabricated_entities": [],
            "selected_node_ids": sorted(selected_node_ids),
            "graph_node_count": len(nodes),
            "jd_token_matches": len(
                jd_tokens
                & _tokens(" ".join(_data_text(nodes[node_id]) for node_id in selected_node_ids))
            ),
            "outcome_ranked_node_count": sum(
                1 for node_id in selected_node_ids if ranking.get(node_id, 0) > 0
            ),
            "compiler_profile_version": compiler_config["profile_version"],
            "ats_ready": quality_report["ats"]["ready"],
            "within_length_budget": quality_report["length"]["within_budget"],
        },
    }
