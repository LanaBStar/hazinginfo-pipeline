"""Content hashing. IDs are content-derived, never SERIAL, so identical archive input
must always produce identical hashes (see CLAUDE.md)."""
import hashlib


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def short_hash(content_hash: str, length: int = 16) -> str:
    """The archive's per-document directory name (`docs/{content_hash[:16]}/`)."""
    return content_hash[:length]
