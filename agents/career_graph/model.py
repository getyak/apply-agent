"""Pure Career Graph validation, change application, and résumé compilation.

The graph is the source of truth. A compilation may select and order facts but
never invent or paraphrase them: every rendered field is copied from a graph
node and recorded in ``selection_manifest``.
"""

from __future__ import annotations

import copy
import re
from datetime import date
from typing import Any

SCHEMA_VERSION = 1
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


_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9+#.\-]{1,}|[\u4e00-\u9fff]{2,}")


def _tokens(value: str) -> set[str]:
    return {token.casefold() for token in _TOKEN_RE.findall(value)}


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
    max_achievements_per_role: int = 4,
    evidence_ranking: dict[str, int] | None = None,
) -> dict[str, Any]:
    """Compile a JSON Resume document from graph facts for one JD.

    Matching affects selection and ordering only. No text is generated. The
    returned manifest proves which source node supplied every rendered block.
    """

    require_valid_snapshot(snapshot)
    if max_achievements_per_role < 1:
        raise ValueError("max_achievements_per_role must be positive")

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
        selected_node_ids.add(person["id"])

    role_nodes = [node for node in nodes.values() if node["type"] == "role"]
    role_nodes.sort(
        key=lambda node: _date_sort_key(node.get("data", {}).get("start_date")),
        reverse=True,
    )
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
            if node_id in nodes and nodes[node_id]["type"] == "achievement"
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
        selected_achievements = achievements[:max_achievements_per_role]
        highlights = [
            achievement["data"]["text"]
            for achievement in selected_achievements
            if isinstance(achievement.get("data", {}).get("text"), str)
            and achievement["data"]["text"].strip()
        ]
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
    for node in education_nodes:
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
    for node in project_nodes:
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
    for node in skill_nodes:
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
    for node in (node for node in nodes.values() if node["type"] == "certification"):
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
    for node in (node for node in nodes.values() if node["type"] == "language"):
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

    return {
        "resume": resume,
        "selection_manifest": manifest,
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
        },
    }
