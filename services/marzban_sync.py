import json
import logging
import time
from datetime import datetime
from typing import Any, Dict, List, Optional, Set

from config import config
from db.database import get_db_connection
from services.marzban import marzban_manager
from services.secrets import secret_manager

logger = logging.getLogger(__name__)

MAINTENANCE_MARKER = " [ИДУТ РАБОТЫ]"

INBOUND_ROLE_MAP: Dict[str, str] = {
    "IN-RU-DIRECT": "direct_ru",
    "IN-EU-DIRECT": "direct_eu",
    "IN-TRANSIT-GB": "transit_sender",
    "IN-TRANSIT-NO": "transit_sender",
    "IN-EU-TRANSIT-RECV": "transit_receiver",
    "IN-EU-DIRECT-WARP": "warp",
}


def _node_address(node: Dict[str, Any]) -> str:
    return str(node.get("address") or node.get("ip") or node.get("host") or "").strip()


def _node_name(node: Dict[str, Any], address: str) -> str:
    return str(node.get("name") or node.get("remark") or address).strip()


def _node_status(node: Dict[str, Any]) -> str:
    status = node.get("status")
    if status is None:
        return "unknown"
    return str(status)


def _local_status(marzban_status: str) -> str:
    lowered = marzban_status.lower()
    if lowered in {"disabled", "error", "disconnected"}:
        return "offline"
    return "active"


def _safe_int(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _safe_float(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _credential_status(row: Optional[Dict[str, Any]]) -> str:
    if not row:
        return "missing"
    if row.get("ssh_key") or row.get("ssh_password"):
        return "configured"
    return "missing"


def _strip_marker(value: str) -> str:
    return value.replace(MAINTENANCE_MARKER, "").strip()


def _find_node(
    marzban_nodes: List[Dict[str, Any]],
    *,
    marzban_node_id: Optional[int] = None,
    address: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    normalized_address = (address or "").strip()

    for node in marzban_nodes:
        if marzban_node_id is not None and _safe_int(node.get("id")) == marzban_node_id:
            return node

        if normalized_address and _node_address(node) == normalized_address:
            return node

    return None


def _matching_hosts_for_address(hosts: Dict[str, Any], address: str) -> List[Dict[str, Any]]:
    matched: List[Dict[str, Any]] = []
    for inbound_tag, group in hosts.items():
        if not isinstance(group, list):
            continue

        for item in group:
            if not isinstance(item, dict):
                continue

            item_address = str(item.get("address") or "").strip()
            if item_address != address:
                continue

            matched.append({"inbound_tag": str(inbound_tag), "host": item})

    return matched


async def sync_single_marzban_node(
    *,
    marzban_node_id: Optional[int] = None,
    address: Optional[str] = None,
    ssh_username: Optional[str] = None,
    ssh_key: Optional[str] = None,
    ssh_password: Optional[str] = None,
    ssh_port: Optional[int] = None,
    billing_date: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Imports one selected Marzban Node and all host bindings matching its IP.

    This is used by the add-existing-node UI: Marzban is still the source of
    truth for node/host data, while LUFFY only adds local SSH credentials.
    """
    marzban_nodes = await marzban_manager.get_nodes()
    if not marzban_nodes:
        return {
            "status": "error",
            "message": "Marzban не вернул список nodes.",
        }

    selected = _find_node(
        marzban_nodes,
        marzban_node_id=marzban_node_id,
        address=address,
    )
    if not selected:
        return {
            "status": "error",
            "message": "Выбранная Marzban Node не найдена.",
        }

    node_address = _node_address(selected)
    if not node_address:
        return {
            "status": "error",
            "message": "У выбранной Marzban Node нет IP/address.",
        }

    hosts = await marzban_manager.get_hosts()
    matching_hosts = _matching_hosts_for_address(hosts, node_address)
    now = int(time.time())
    node_name = _node_name(selected, node_address)
    marzban_status = _node_status(selected)
    raw_json = json.dumps(selected, ensure_ascii=False, sort_keys=True)

    imported = False
    updated = False
    inbound_count = 0
    roles: Set[str] = set()
    first_inbound: Optional[Dict[str, Any]] = None

    async with get_db_connection() as db:
        async with db.execute("SELECT * FROM nodes WHERE ip = ?", (node_address,)) as cursor:
            existing_row = await cursor.fetchone()
            existing = dict(existing_row) if existing_row else None

        final_ssh_key = existing.get("ssh_key") if existing else None
        final_ssh_password = existing.get("ssh_password") if existing else None

        if isinstance(ssh_key, str) and ssh_key.strip():
            final_ssh_key = secret_manager.encrypt(ssh_key.strip())

        if isinstance(ssh_password, str) and ssh_password.strip():
            final_ssh_password = secret_manager.encrypt(ssh_password.strip())

        final_ssh_username = (
            (ssh_username or "").strip()
            or (str(existing.get("ssh_username")) if existing and existing.get("ssh_username") else "")
            or config.SSH_DEFAULT_USER
        )
        final_ssh_port = int(ssh_port or (existing.get("ssh_port") if existing else 0) or config.SSH_PORT)
        final_billing_date = (
            (billing_date or "").strip()
            or (str(existing.get("billing_date")) if existing and existing.get("billing_date") else "")
            or datetime.now().date().isoformat()
        )
        credential_status = "configured" if final_ssh_key or final_ssh_password else "missing"

        node_id_raw = _safe_int(selected.get("id"))
        port = _safe_int(selected.get("port"))
        api_port = _safe_int(selected.get("api_port"))
        usage_coefficient = _safe_float(selected.get("usage_coefficient"))

        if existing:
            node_id = int(existing["id"])
            await db.execute(
                """
                UPDATE nodes
                SET name = ?,
                    billing_date = ?,
                    status = ?,
                    ssh_key = ?,
                    ssh_password = ?,
                    ssh_username = ?,
                    ssh_port = ?,
                    credential_status = ?,
                    marzban_node_id = ?,
                    marzban_node_name = ?,
                    marzban_node_status = ?,
                    marzban_node_port = ?,
                    marzban_node_api_port = ?,
                    marzban_usage_coefficient = ?,
                    marzban_node_raw = ?,
                    marzban_last_error = NULL,
                    provision_status = 'ready',
                    last_marzban_sync = ?
                WHERE id = ?
                """,
                (
                    node_name,
                    final_billing_date,
                    _local_status(marzban_status),
                    final_ssh_key,
                    final_ssh_password,
                    final_ssh_username,
                    final_ssh_port,
                    credential_status,
                    node_id_raw,
                    node_name,
                    marzban_status,
                    port,
                    api_port,
                    usage_coefficient,
                    raw_json,
                    now,
                    node_id,
                ),
            )
            updated = True
        else:
            cursor = await db.execute(
                """
                INSERT INTO nodes (
                    name, ip, role, billing_date, status,
                    ssh_key, ssh_password, ssh_username, ssh_port, credential_status,
                    inbound_tag, inbound_port, group_sni, fingerprint,
                    marzban_node_id, marzban_node_name, marzban_node_status,
                    marzban_node_port, marzban_node_api_port,
                    marzban_usage_coefficient, marzban_node_raw,
                    provision_status, last_marzban_sync
                ) VALUES (?, ?, 'ingress', ?, ?, ?, ?, ?, ?, ?,
                          'IN-RU-DIRECT', 443, ?, 'chrome',
                          ?, ?, ?, ?, ?, ?, ?, 'ready', ?)
                """,
                (
                    node_name,
                    node_address,
                    final_billing_date,
                    _local_status(marzban_status),
                    final_ssh_key,
                    final_ssh_password,
                    final_ssh_username,
                    final_ssh_port,
                    credential_status,
                    node_address,
                    node_id_raw,
                    node_name,
                    marzban_status,
                    port,
                    api_port,
                    usage_coefficient,
                    raw_json,
                    now,
                ),
            )
            node_id = int(cursor.lastrowid)
            imported = True

        await db.execute("DELETE FROM node_roles WHERE node_id = ?", (node_id,))
        await db.execute("DELETE FROM node_inbounds WHERE node_id = ?", (node_id,))

        for matched in matching_hosts:
            inbound_tag = str(matched["inbound_tag"])
            item = matched["host"]
            role = INBOUND_ROLE_MAP.get(inbound_tag)
            if role:
                roles.add(role)

            remark = str(item.get("remark") or node_address)
            host_port = _safe_int(item.get("port"))
            sni = item.get("sni")
            host = item.get("host")
            fingerprint = item.get("fingerprint")
            security = item.get("security")
            alpn = item.get("alpn")
            is_disabled = 1 if item.get("is_disabled") else 0
            host_raw_json = json.dumps(item, ensure_ascii=False, sort_keys=True)

            await db.execute(
                """
                INSERT INTO node_inbounds (
                    node_id, inbound_tag, remark, address, port,
                    sni, host, fingerprint, security, alpn,
                    is_disabled, original_remark, raw_json, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    node_id,
                    inbound_tag,
                    remark,
                    node_address,
                    host_port,
                    sni,
                    host,
                    fingerprint,
                    security,
                    alpn,
                    is_disabled,
                    _strip_marker(remark),
                    host_raw_json,
                    now,
                ),
            )
            inbound_count += 1

            first_inbound = first_inbound or {
                "inbound_tag": inbound_tag,
                "port": host_port or 443,
                "sni": sni or host or node_address,
                "fingerprint": fingerprint or "chrome",
            }

        for role in sorted(roles):
            await db.execute(
                "INSERT OR IGNORE INTO node_roles (node_id, role, created_at) VALUES (?, ?, ?)",
                (node_id, role, now),
            )

        if first_inbound:
            await db.execute(
                """
                UPDATE nodes
                SET inbound_tag = ?,
                    inbound_port = ?,
                    group_sni = ?,
                    fingerprint = ?
                WHERE id = ?
                """,
                (
                    first_inbound["inbound_tag"],
                    int(first_inbound["port"] or 443),
                    str(first_inbound["sni"] or ""),
                    str(first_inbound["fingerprint"] or "chrome"),
                    node_id,
                ),
            )

        await db.commit()

    status = "success" if inbound_count else "partial"
    return {
        "status": status,
        "message": (
            f"Marzban Node {node_name} импортирована."
            if status == "success"
            else f"Marzban Node {node_name} импортирована, но matching hosts по IP не найдены."
        ),
        "node_id": node_id,
        "imported": imported,
        "updated": updated,
        "inbounds": inbound_count,
        "roles": sorted(roles),
    }


async def sync_marzban_inventory() -> Dict[str, Any]:
    """
    Imports/syncs Marzban Nodes and their hosts into local inventory.

    Marzban remains the source of truth. Existing local records are matched by
    IP address and updated in place, preserving credentials and billing dates.
    """
    marzban_nodes = await marzban_manager.get_nodes()
    hosts = await marzban_manager.get_hosts()
    now = int(time.time())
    today = datetime.now().date().isoformat()

    if not marzban_nodes:
        return {
            "status": "error",
            "message": "Marzban не вернул список nodes.",
            "imported": 0,
            "updated": 0,
            "inbounds": 0,
            "unmatched_hosts": [],
        }

    node_by_ip: Dict[str, Dict[str, Any]] = {}
    for node in marzban_nodes:
        address = _node_address(node)
        if not address:
            continue
        node_by_ip[address] = node

    imported = 0
    updated = 0
    inbound_count = 0

    async with get_db_connection() as db:
        local_by_ip: Dict[str, Dict[str, Any]] = {}
        async with db.execute("SELECT * FROM nodes") as cursor:
            rows = await cursor.fetchall()
            for row in rows:
                local_by_ip[str(row["ip"])] = dict(row)

        node_id_by_ip: Dict[str, int] = {}

        for address, node in node_by_ip.items():
            existing = local_by_ip.get(address)
            name = _node_name(node, address)
            marzban_status = _node_status(node)
            node_id_raw = _safe_int(node.get("id"))
            port = _safe_int(node.get("port"))
            api_port = _safe_int(node.get("api_port"))
            usage_coefficient = _safe_float(node.get("usage_coefficient"))
            raw_json = json.dumps(node, ensure_ascii=False, sort_keys=True)

            if existing:
                node_id = int(existing["id"])
                await db.execute(
                    """
                    UPDATE nodes
                    SET name = ?,
                        status = ?,
                        ssh_username = COALESCE(NULLIF(ssh_username, ''), ?),
                        credential_status = ?,
                        marzban_node_id = ?,
                        marzban_node_name = ?,
                        marzban_node_status = ?,
                        marzban_node_port = ?,
                        marzban_node_api_port = ?,
                        marzban_usage_coefficient = ?,
                        marzban_node_raw = ?,
                        marzban_last_error = NULL,
                        provision_status = 'ready',
                        last_marzban_sync = ?
                    WHERE id = ?
                    """,
                    (
                        name,
                        _local_status(marzban_status),
                        config.SSH_DEFAULT_USER,
                        _credential_status(existing),
                        node_id_raw,
                        name,
                        marzban_status,
                        port,
                        api_port,
                        usage_coefficient,
                        raw_json,
                        now,
                        node_id,
                    ),
                )
                updated += 1
            else:
                cursor = await db.execute(
                    """
                    INSERT INTO nodes (
                        name, ip, role, billing_date, status,
                        ssh_username, ssh_port, credential_status,
                        inbound_tag, inbound_port, group_sni, fingerprint,
                        marzban_node_id, marzban_node_name, marzban_node_status,
                        marzban_node_port, marzban_node_api_port,
                        marzban_usage_coefficient, marzban_node_raw,
                        provision_status, last_marzban_sync
                    ) VALUES (?, ?, 'ingress', ?, ?, ?, ?, 'missing',
                              'IN-RU-DIRECT', 443, ?, 'chrome',
                              ?, ?, ?, ?, ?, ?, ?, 'ready', ?)
                    """,
                    (
                        name,
                        address,
                        today,
                        _local_status(marzban_status),
                        config.SSH_DEFAULT_USER,
                        config.SSH_PORT,
                        address,
                        node_id_raw,
                        name,
                        marzban_status,
                        port,
                        api_port,
                        usage_coefficient,
                        raw_json,
                        now,
                    ),
                )
                node_id = int(cursor.lastrowid)
                imported += 1

            node_id_by_ip[address] = node_id

        for node_id in node_id_by_ip.values():
            await db.execute("DELETE FROM node_roles WHERE node_id = ?", (node_id,))
            await db.execute("DELETE FROM node_inbounds WHERE node_id = ?", (node_id,))

        roles_by_node: Dict[int, Set[str]] = {node_id: set() for node_id in node_id_by_ip.values()}
        first_inbound_by_node: Dict[int, Dict[str, Any]] = {}
        unmatched_hosts: List[Dict[str, Any]] = []

        for inbound_tag, group in hosts.items():
            if not isinstance(group, list):
                continue

            role = INBOUND_ROLE_MAP.get(str(inbound_tag))
            for item in group:
                if not isinstance(item, dict):
                    continue
                address = str(item.get("address") or "").strip()
                if not address or "{" in address or "}" in address:
                    continue

                node_id = node_id_by_ip.get(address)
                if not node_id:
                    unmatched_hosts.append(
                        {
                            "inbound_tag": inbound_tag,
                            "address": address,
                            "remark": item.get("remark"),
                        }
                    )
                    continue

                if role:
                    roles_by_node[node_id].add(role)

                remark = str(item.get("remark") or address)
                port = _safe_int(item.get("port"))
                sni = item.get("sni")
                host = item.get("host")
                fingerprint = item.get("fingerprint")
                security = item.get("security")
                alpn = item.get("alpn")
                is_disabled = 1 if item.get("is_disabled") else 0
                raw_json = json.dumps(item, ensure_ascii=False, sort_keys=True)

                await db.execute(
                    """
                    INSERT INTO node_inbounds (
                        node_id, inbound_tag, remark, address, port,
                        sni, host, fingerprint, security, alpn,
                        is_disabled, original_remark, raw_json, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        node_id,
                        str(inbound_tag),
                        remark,
                        address,
                        port,
                        sni,
                        host,
                        fingerprint,
                        security,
                        alpn,
                        is_disabled,
                        _strip_marker(remark),
                        raw_json,
                        now,
                    ),
                )
                inbound_count += 1

                first_inbound_by_node.setdefault(
                    node_id,
                    {
                        "inbound_tag": str(inbound_tag),
                        "port": port or 443,
                        "sni": sni or host or address,
                        "fingerprint": fingerprint or "chrome",
                    },
                )

        for node_id, roles in roles_by_node.items():
            for role in sorted(roles):
                await db.execute(
                    "INSERT OR IGNORE INTO node_roles (node_id, role, created_at) VALUES (?, ?, ?)",
                    (node_id, role, now),
                )

            first = first_inbound_by_node.get(node_id)
            if first:
                await db.execute(
                    """
                    UPDATE nodes
                    SET inbound_tag = ?,
                        inbound_port = ?,
                        group_sni = ?,
                        fingerprint = ?
                    WHERE id = ?
                    """,
                    (
                        first["inbound_tag"],
                        int(first["port"] or 443),
                        str(first["sni"] or ""),
                        str(first["fingerprint"] or "chrome"),
                        node_id,
                    ),
                )

        await db.commit()

    status = "success" if not unmatched_hosts else "partial"
    return {
        "status": status,
        "message": (
            "Импорт Marzban завершен."
            if status == "success"
            else "Импорт Marzban завершен, но найдены hosts без соответствующей Marzban Node."
        ),
        "imported": imported,
        "updated": updated,
        "inbounds": inbound_count,
        "unmatched_hosts": unmatched_hosts,
    }
