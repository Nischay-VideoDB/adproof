#!/usr/bin/env python3
"""Read-only validation for the fixed saved-run playback registry.

This utility never generates streams and never writes the database. The
registry itself is supplied through the sensitive server-only JSON environment
value used by production.
"""

from __future__ import annotations

import argparse
import json
import os

from adproof.db import SessionLocal
from adproof.showcase_playback import (
    PINNED_SHOWCASE_MANIFEST_HASH,
    health_check_showcase_playback,
    inspect_showcase_manifest,
    preflight_showcase_playback,
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--inspect",
        action="store_true",
        help="Inspect immutable DB citation membership without reading the registry.",
    )
    parser.add_argument(
        "--health-check",
        action="store_true",
        help="Validate every frozen HLS chain without writes or generation.",
    )
    parser.add_argument("--workspace-id", default=os.getenv("ADPROOF_SHOWCASE_WORKSPACE_ID"))
    parser.add_argument("--expected-cited-references", type=int, default=22)
    parser.add_argument("--expected-receipts", type=int, default=23)
    parser.add_argument("--expected-manifest-hash", default=PINNED_SHOWCASE_MANIFEST_HASH)
    args = parser.parse_args()
    if not args.workspace_id:
        parser.error("--workspace-id or ADPROOF_SHOWCASE_WORKSPACE_ID is required")
    if args.inspect and args.health_check:
        parser.error("--inspect and --health-check are mutually exclusive")

    with SessionLocal() as session:
        if args.inspect:
            result = inspect_showcase_manifest(session, args.workspace_id)
        elif args.health_check:
            result = health_check_showcase_playback(
                session,
                args.workspace_id,
                expected_cited_references=args.expected_cited_references,
                expected_receipts=args.expected_receipts,
                expected_manifest_hash=args.expected_manifest_hash,
            )
        else:
            result = preflight_showcase_playback(
                session,
                args.workspace_id,
                expected_cited_references=args.expected_cited_references,
                expected_receipts=args.expected_receipts,
                expected_manifest_hash=args.expected_manifest_hash,
            )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if args.inspect or result.get("ready", False) else 1


if __name__ == "__main__":
    raise SystemExit(main())
