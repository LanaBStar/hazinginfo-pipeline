"""Read-only access to the OLD system's R2 bucket, for migration/ scripts only.

Mirrors lib/r2.py's local-filesystem-fallback pattern (OLD_ARCHIVE_LOCAL_ROOT instead of
ARCHIVE_LOCAL_ROOT) so tests can run against a fixture directory with no live credentials,
same as every other job in this codebase. Deliberately has no put_bytes: migration must
never write to the old system (IMPLEMENTATION_PLAN.md Section 13 -- the old captures are
irreplaceable evidence, never touched, only read once and copied into the new archive).

Importing this module never touches credentials or the network: the boto3 client is
created lazily, on first real call. Never prints, logs, or includes an environment
variable's *value* -- only its name (same rule as lib/r2.py).
"""
import os
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from dotenv import load_dotenv

load_dotenv()

_client = None


class MissingEnvVar(RuntimeError):
    def __init__(self, name: str):
        super().__init__(f"missing required environment variable: {name}")


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise MissingEnvVar(name)
    return value


def _local_root() -> Path | None:
    root = os.environ.get("OLD_ARCHIVE_LOCAL_ROOT")
    return Path(root) if root else None


def _get_client():
    global _client
    if _client is None:
        _client = boto3.client(
            "s3",
            endpoint_url=_require_env("OLD_R2_ENDPOINT_URL"),
            aws_access_key_id=_require_env("OLD_R2_ACCESS_KEY_ID"),
            aws_secret_access_key=_require_env("OLD_R2_SECRET_ACCESS_KEY"),
            region_name="auto",
        )
    return _client


def _bucket() -> str:
    return _require_env("OLD_R2_BUCKET_NAME")


def get_bytes(key: str) -> bytes:
    root = _local_root()
    if root is not None:
        return (root / key).read_bytes()
    client = _get_client()
    obj = client.get_object(Bucket=_bucket(), Key=key)
    return obj["Body"].read()


def exists(key: str) -> bool:
    root = _local_root()
    if root is not None:
        return (root / key).is_file()
    client = _get_client()
    try:
        client.head_object(Bucket=_bucket(), Key=key)
        return True
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") in ("404", "NoSuchKey"):
            return False
        raise
