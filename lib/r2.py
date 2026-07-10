"""R2 (Cloudflare, S3-compatible) archive access, with a local-filesystem fallback for
tests and the fixtures smoke run (IMPLEMENTATION_PLAN.md §14).

If ARCHIVE_LOCAL_ROOT is set, every function below reads/writes that directory instead of
calling R2 - the local directory mirrors the R2 key layout exactly (a key is just a path
relative to the root). This is how status.py's smoke check runs against a hand-made mini
archive with no real credentials.

Importing this module never touches credentials or the network: the boto3 client is
created lazily, on first real R2 call, so every script here stays import-safe with no
.env at all. Per the project's credential-safety rule, this module never prints, logs, or
includes an environment variable's *value* anywhere - only its name.
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
    root = os.environ.get("ARCHIVE_LOCAL_ROOT")
    return Path(root) if root else None


def _get_client():
    global _client
    if _client is None:
        _client = boto3.client(
            "s3",
            endpoint_url=_require_env("R2_ENDPOINT_URL"),
            aws_access_key_id=_require_env("R2_ACCESS_KEY_ID"),
            aws_secret_access_key=_require_env("R2_SECRET_ACCESS_KEY"),
            region_name="auto",
        )
    return _client


def _bucket() -> str:
    return _require_env("R2_BUCKET_NAME")


def list_keys(prefix: str) -> list[str]:
    """Every key under `prefix`, sorted. Keys are full paths (e.g. `archive/123_x/2026/status.json`)."""
    root = _local_root()
    if root is not None:
        base = root / prefix
        if not base.exists():
            return []
        return sorted(
            str(path.relative_to(root)) for path in base.rglob("*") if path.is_file()
        )

    client = _get_client()
    bucket = _bucket()
    keys = []
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            keys.append(obj["Key"])
    return sorted(keys)


def get_bytes(key: str) -> bytes:
    root = _local_root()
    if root is not None:
        return (root / key).read_bytes()
    client = _get_client()
    obj = client.get_object(Bucket=_bucket(), Key=key)
    return obj["Body"].read()


def put_bytes(key: str, body: bytes) -> None:
    root = _local_root()
    if root is not None:
        path = root / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        return
    client = _get_client()
    client.put_object(Bucket=_bucket(), Key=key, Body=body)


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
