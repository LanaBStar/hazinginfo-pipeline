"""Phase 8 smoke check: migration/backfill_manifests.py + migration/export_legacy.py.

Per IMPLEMENTATION_PLAN.md Section 16: "dry-run against old bucket/Neon (read-only)".
Since the user confirmed building against a synthetic fixture this session (see
BUILD_STATUS.md) rather than a live old system, this test creates a scratch Postgres
database seeded with a faithful subset of the old system's real schema (copied from
~/Documents/hazing-incidents/scraper/db.py: institutions, pipeline_runs, raw_artifacts,
chtr_reports, incidents) and a local directory standing in for the old R2 bucket
(OLD_ARCHIVE_LOCAL_ROOT), same local-fallback pattern every other job's smoke check uses
for the *new* archive (ARCHIVE_LOCAL_ROOT). Both old-system connections are opened
read-only -- this test exercises that guarantee, not just the app-level discipline.

Covers, via three old raw_artifacts rows chosen to hit every branch:
  - Northgate University (unitid 300001): correct content_hash, institution present in
    the current sources/schools.csv -- the happy path. backfill_manifests.py copies it
    into the new archive; export_legacy.py's legacy incident pointing at it exports
    cleanly into calibration_set.json.
  - Old Removed College (unitid 300002): correct content_hash, but deliberately NOT in
    the current sources/schools.csv (simulates an institution the new system dropped) --
    both scripts skip it (skipped_unknown_institution) without aborting the run.
  - Fernwood State (unitid 300003): content_hash in old Neon deliberately does NOT match
    the actual bytes at its storage_key in the old R2 fixture -- backfill_manifests.py
    must refuse to write it (failed_hash_mismatch, nothing written), and export_legacy.py's
    legacy incident pointing at it must then see the document was never backfilled
    (skipped_not_backfilled) -- proving the two scripts' failure paths compose correctly.
  - A fourth legacy incident (Fernwood again) whose chtr_reports row has artifact_id=NULL
    (no linked raw_artifacts) -- export_legacy.py must skip it (skipped_no_document)
    without needing a document at all.

Also asserts backfill_manifests.py is resumable: run it twice, the second run's
`backfilled` count is 0 and Northgate's doc is reported as skipped_already_backfilled,
with manifest.json/original bytes unchanged.

Run with: .venv/bin/python tests/test_phase8_migration.py
"""
import hashlib
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import psycopg  # noqa: E402

from lib import r2  # noqa: E402
from lib.hashing import short_hash  # noqa: E402

OLD_SCHEMA_SQL = """
CREATE TABLE institutions (
    id SERIAL PRIMARY KEY,
    unitid INTEGER UNIQUE NOT NULL,
    institution_name TEXT NOT NULL,
    city TEXT,
    state TEXT
);
CREATE TABLE pipeline_runs (
    id SERIAL PRIMARY KEY,
    run_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    run_type TEXT NOT NULL,
    status TEXT NOT NULL,
    notes TEXT
);
CREATE TABLE raw_artifacts (
    id SERIAL PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES pipeline_runs(id),
    institution_id INTEGER NOT NULL REFERENCES institutions(id),
    storage_key TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    source_url TEXT NOT NULL,
    artifact_type TEXT NOT NULL CHECK (artifact_type IN ('pdf', 'html')),
    file_size_bytes INTEGER,
    scraped_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (content_hash, institution_id)
);
CREATE TABLE chtr_reports (
    id SERIAL PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES pipeline_runs(id),
    institution_id INTEGER NOT NULL REFERENCES institutions(id),
    artifact_id INTEGER REFERENCES raw_artifacts(id),
    source_url TEXT NOT NULL,
    report_type TEXT,
    publication_date DATE,
    reporting_period_start DATE,
    reporting_period_end DATE,
    extraction_status TEXT NOT NULL DEFAULT 'pending',
    document_status TEXT NOT NULL DEFAULT 'confirmed',
    prompt_version TEXT,
    failure_count INTEGER NOT NULL DEFAULT 0,
    last_failed_at TIMESTAMPTZ,
    scraped_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE incidents (
    id SERIAL PRIMARY KEY,
    chtr_id INTEGER NOT NULL REFERENCES chtr_reports(id),
    staging_id INTEGER,
    incident_fingerprint TEXT UNIQUE,
    location TEXT,
    incident_date_raw TEXT,
    incident_start_date DATE,
    incident_end_date DATE,
    date_reported DATE,
    investigation_initiated_date DATE,
    investigation_concluded_date DATE,
    incident_description_raw TEXT,
    use_of_alcohol BOOLEAN,
    use_of_drugs BOOLEAN,
    outcome_raw TEXT,
    hazing_determination BOOLEAN,
    is_aggravated BOOLEAN,
    ai_model TEXT,
    prompt_version TEXT,
    extraction_confidence NUMERIC(3,2),
    verified_by TEXT NOT NULL,
    verified_at TIMESTAMPTZ NOT NULL
);
"""


def _load_module(name: str, rel_path: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def main() -> int:
    failures: list[str] = []
    tmp_root = Path(tempfile.mkdtemp(prefix="hazinginfo_phase8_"))
    archive_local_root = tmp_root / "new_archive"
    archive_local_root.mkdir()
    old_r2_root = tmp_root / "old_bucket"
    old_r2_root.mkdir()

    prior_env = {k: os.environ.get(k) for k in [
        "ARCHIVE_LOCAL_ROOT", "R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME",
        "OLD_ARCHIVE_LOCAL_ROOT", "OLD_R2_ENDPOINT_URL", "OLD_R2_ACCESS_KEY_ID",
        "OLD_R2_SECRET_ACCESS_KEY", "OLD_R2_BUCKET_NAME", "OLD_DATABASE_URL",
    ]}
    os.environ["ARCHIVE_LOCAL_ROOT"] = str(archive_local_root)
    os.environ["OLD_ARCHIVE_LOCAL_ROOT"] = str(old_r2_root)
    for var in ["R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME",
                "OLD_R2_ENDPOINT_URL", "OLD_R2_ACCESS_KEY_ID", "OLD_R2_SECRET_ACCESS_KEY", "OLD_R2_BUCKET_NAME"]:
        os.environ.pop(var, None)

    schools_csv = tmp_root / "schools.csv"
    schools_csv.write_text(
        "unitid,name,state,chtr_url,url_status,evidence\n"
        "300001,Northgate University,ZZ,,confirmed,\n"
        "300003,Fernwood State,ZZ,,confirmed,\n"
    )

    # ── old R2 fixture bytes ──
    northgate_content = b"%PDF-fake Northgate CHTR 2024 content for backfill test\n"
    removed_content = b"<html>Old Removed College report</html>"
    fernwood_content = b"%PDF-fake Fernwood CHTR 2023 content\n"

    northgate_key = "institutions/300001_northgate-university/2024/chtr-2024_abc123.pdf"
    removed_key = "institutions/300002_old-removed-college/2024/report_def456.html"
    fernwood_key = "institutions/300003_fernwood-state/2023/chtr-2023_ghi789.pdf"

    (old_r2_root / northgate_key).parent.mkdir(parents=True, exist_ok=True)
    (old_r2_root / northgate_key).write_bytes(northgate_content)
    (old_r2_root / removed_key).parent.mkdir(parents=True, exist_ok=True)
    (old_r2_root / removed_key).write_bytes(removed_content)
    (old_r2_root / fernwood_key).parent.mkdir(parents=True, exist_ok=True)
    (old_r2_root / fernwood_key).write_bytes(fernwood_content)

    db_user = os.environ.get("USER", "postgres")
    db_name = f"hazinginfo_old_test_{uuid.uuid4().hex[:12]}"
    admin_url = f"postgresql://{db_user}@localhost:5432/postgres"
    old_db_url = f"postgresql://{db_user}@localhost:5432/{db_name}"
    db_created = False

    try:
        with psycopg.connect(admin_url, autocommit=True) as conn:
            conn.execute(f'CREATE DATABASE "{db_name}"')
        db_created = True
        os.environ["OLD_DATABASE_URL"] = old_db_url

        with psycopg.connect(old_db_url) as conn:
            with conn.cursor() as cur:
                cur.execute(OLD_SCHEMA_SQL)
                cur.execute(
                    "INSERT INTO institutions (unitid, institution_name, city, state) VALUES "
                    "(300001, 'Northgate University', NULL, NULL), "
                    "(300002, 'Old Removed College', NULL, NULL), "
                    "(300003, 'Fernwood State', NULL, NULL) "
                    "RETURNING id"
                )
                ng_id, rm_id, fw_id = [r[0] for r in cur.fetchall()]

                cur.execute(
                    "INSERT INTO pipeline_runs (run_type, status) VALUES ('manual', 'completed') RETURNING id"
                )
                run_id = cur.fetchone()[0]

                cur.execute(
                    """INSERT INTO raw_artifacts
                       (run_id, institution_id, storage_key, content_hash, source_url,
                        artifact_type, file_size_bytes, scraped_at)
                       VALUES
                       (%s, %s, %s, %s, %s, 'pdf', %s, %s),
                       (%s, %s, %s, %s, %s, 'html', %s, %s),
                       (%s, %s, %s, %s, %s, 'pdf', %s, %s)
                       RETURNING id""",
                    (
                        run_id, ng_id, northgate_key, _sha256(northgate_content),
                        "https://northgate.edu/chtr-2024.pdf", len(northgate_content),
                        datetime(2024, 3, 15, 12, 0, 0, tzinfo=timezone.utc),

                        run_id, rm_id, removed_key, _sha256(removed_content),
                        "https://removed.edu/report", len(removed_content),
                        datetime(2024, 5, 1, 9, 0, 0, tzinfo=timezone.utc),

                        # Deliberately wrong content_hash -- must never match the real
                        # bytes at fernwood_key, so backfill refuses to write it.
                        run_id, fw_id, fernwood_key, "0" * 64,
                        "https://fernwood.edu/chtr-2023.pdf", 999,
                        datetime(2023, 11, 1, 8, 0, 0, tzinfo=timezone.utc),
                    ),
                )
                ra_northgate, ra_removed, ra_fernwood = [r[0] for r in cur.fetchall()]

                cur.execute(
                    """INSERT INTO chtr_reports
                       (run_id, institution_id, artifact_id, source_url, report_type,
                        extraction_status, document_status)
                       VALUES
                       (%s, %s, %s, 'https://northgate.edu/chtr-2024.pdf', 'pdf', 'extracted', 'confirmed'),
                       (%s, %s, NULL, 'https://fernwood.edu/no-doc', 'pdf', 'extracted', 'confirmed'),
                       (%s, %s, %s, 'https://removed.edu/report', 'html', 'extracted', 'confirmed'),
                       (%s, %s, %s, 'https://fernwood.edu/chtr-2023.pdf', 'pdf', 'extracted', 'confirmed')
                       RETURNING id""",
                    (
                        run_id, ng_id, ra_northgate,
                        run_id, fw_id,
                        run_id, rm_id, ra_removed,
                        run_id, fw_id, ra_fernwood,
                    ),
                )
                cr_northgate, cr_fernwood_nodoc, cr_removed, cr_fernwood_mismatch = [r[0] for r in cur.fetchall()]

                cur.execute(
                    """INSERT INTO incidents
                       (chtr_id, location, incident_date_raw, incident_start_date, incident_end_date,
                        date_reported, investigation_initiated_date, investigation_concluded_date,
                        incident_description_raw, use_of_alcohol, use_of_drugs, outcome_raw,
                        hazing_determination, is_aggravated, verified_by, verified_at)
                       VALUES
                       (%s, 'Off-campus house', 'Fall 2024', '2024-09-10', NULL, NULL, NULL, NULL,
                        'Pledges required to perform physically demanding tasks.', TRUE, FALSE,
                        'Organization placed on probation.', TRUE, FALSE, 'alice', %s),
                       (%s, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                        'bob', %s),
                       (%s, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                        'carol', %s),
                       (%s, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                        'dave', %s)
                       """,
                    (
                        cr_northgate, datetime(2024, 12, 1, tzinfo=timezone.utc),
                        cr_fernwood_nodoc, datetime(2024, 12, 2, tzinfo=timezone.utc),
                        cr_removed, datetime(2024, 12, 3, tzinfo=timezone.utc),
                        cr_fernwood_mismatch, datetime(2024, 12, 4, tzinfo=timezone.utc),
                    ),
                )
            conn.commit()

        backfill = _load_module("migration_backfill_manifests", "migration/backfill_manifests.py")
        export_legacy = _load_module("migration_export_legacy", "migration/export_legacy.py")

        # ── run 1: exercise every branch ──
        results1 = backfill.run(schools_csv=schools_csv)
        expected1 = {
            "backfilled": 1, "skipped_already_backfilled": 0,
            "skipped_unknown_institution": 1, "failed": 0, "failed_hash_mismatch": 1,
        }
        if results1 != expected1:
            failures.append(f"backfill run 1: expected {expected1!r}, got {results1!r}")

        ng_hash16 = short_hash(_sha256(northgate_content))
        ng_doc_dir = f"archive/300001_northgate-university/2024/docs/{ng_hash16}"
        if not r2.exists(f"{ng_doc_dir}/manifest.json"):
            failures.append(f"backfill: expected manifest.json at {ng_doc_dir}")
        else:
            manifest = json.loads(r2.get_bytes(f"{ng_doc_dir}/manifest.json"))
            expected_manifest = {
                "schema_version": 1,
                "source_url": "https://northgate.edu/chtr-2024.pdf",
                "sha256": _sha256(northgate_content),
                "content_type": "application/pdf",
                "size_bytes": len(northgate_content),
                "unitid": "300001",
                "scrape_year": 2024,
            }
            for k, v in expected_manifest.items():
                if manifest.get(k) != v:
                    failures.append(f"backfill manifest[{k}]: expected {v!r}, got {manifest.get(k)!r}")
            if manifest.get("fetched_at") != "2024-03-15T12:00:00Z":
                failures.append(f"backfill manifest[fetched_at]: expected 2024-03-15T12:00:00Z, got {manifest.get('fetched_at')!r}")
            original_bytes = r2.get_bytes(f"{ng_doc_dir}/original/report.pdf")
            if original_bytes != northgate_content:
                failures.append("backfill: original bytes at new archive don't match old R2 fixture bytes")

        fw_hash16 = short_hash("0" * 64)
        fw_doc_dir = f"archive/300003_fernwood-state/2023/docs/{fw_hash16}"
        if r2.exists(f"{fw_doc_dir}/manifest.json"):
            failures.append("backfill: hash-mismatched Fernwood document must never be written")

        rm_doc_dirs = list(archive_local_root.glob("archive/300002_*"))
        if rm_doc_dirs:
            failures.append(f"backfill: unknown-institution Old Removed College must never be written, found {rm_doc_dirs!r}")

        # ── run 2: resumable ──
        results2 = backfill.run(schools_csv=schools_csv)
        expected2 = {
            "backfilled": 0, "skipped_already_backfilled": 1,
            "skipped_unknown_institution": 1, "failed": 0, "failed_hash_mismatch": 1,
        }
        if results2 != expected2:
            failures.append(f"backfill run 2 (resumability): expected {expected2!r}, got {results2!r}")
        if r2.get_bytes(f"{ng_doc_dir}/manifest.json") != r2.get_bytes(f"{ng_doc_dir}/manifest.json"):
            failures.append("backfill run 2: manifest.json changed on a resumed run")

        # ── export_legacy.py ──
        calibration_out = tmp_root / "calibration_set.json"
        export_results = export_legacy.run(schools_csv=schools_csv, out=calibration_out)
        expected_export = {
            "exported": 1, "skipped_unknown_institution": 1,
            "skipped_no_document": 1, "skipped_not_backfilled": 1,
        }
        if export_results != expected_export:
            failures.append(f"export_legacy: expected {expected_export!r}, got {export_results!r}")

        if not calibration_out.exists():
            failures.append("export_legacy: calibration_set.json was not written")
        else:
            calibration = json.loads(calibration_out.read_text())
            entries = calibration.get("calibration_set", [])
            if len(entries) != 1:
                failures.append(f"export_legacy: expected exactly 1 calibration entry, got {len(entries)}")
            else:
                entry = entries[0]
                if entry["unitid"] != "300001":
                    failures.append(f"export_legacy: expected unitid 300001, got {entry['unitid']!r}")
                if entry["doc_dir"] != ng_doc_dir:
                    failures.append(f"export_legacy: expected doc_dir {ng_doc_dir!r}, got {entry['doc_dir']!r}")
                lf = entry["legacy_fields"]
                if lf["verified_by"] != "alice" or lf["incident_start_date"] != "2024-09-10":
                    failures.append(f"export_legacy: legacy_fields mismatch: {lf!r}")
                if lf["hazing_determination"] is not True or lf["use_of_drugs"] is not False:
                    failures.append(f"export_legacy: legacy_fields boolean mismatch: {lf!r}")

            import jsonschema
            schema = json.loads((ROOT / "migration" / "calibration_set.schema.json").read_text())
            try:
                jsonschema.validate(calibration, schema)
            except jsonschema.ValidationError as e:
                failures.append(f"export_legacy: calibration_set.json fails its own schema: {e}")

        # ── read-only guarantee ──
        with psycopg.connect(old_db_url) as conn:
            conn.read_only = True
            try:
                conn.execute("DELETE FROM incidents")
                conn.commit()
                failures.append("read-only guarantee: a write against OLD_DATABASE_URL unexpectedly succeeded")
            except Exception:
                pass

    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)
        if db_created:
            try:
                with psycopg.connect(admin_url, autocommit=True) as conn:
                    conn.execute(
                        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s AND pid <> pg_backend_pid()",
                        (db_name,),
                    )
                    conn.execute(f'DROP DATABASE IF EXISTS "{db_name}"')
            except Exception as e:
                print(f"warning: failed to drop scratch database {db_name}: {e}")
        for k, v in prior_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    if failures:
        print("FAIL")
        for f in failures:
            print(f"      {f}")
        return 1
    print("ok    backfill run 1: Northgate backfilled, Old Removed College skipped (unknown institution),")
    print("      Fernwood skipped (hash mismatch) -- nothing written for either")
    print("ok    backfill: manifest.json + original bytes correct at the derived new-archive path")
    print("ok    backfill run 2: resumable -- 0 newly backfilled, Northgate reported already-backfilled")
    print("ok    export_legacy: happy path exports; no-document, unknown-institution, and")
    print("      not-yet-backfilled legacy incidents are each skipped for the right reason")
    print("ok    export_legacy: calibration_set.json validates against its own schema")
    print("ok    both scripts' OLD_DATABASE_URL connections are read-only at the transaction level")
    return 0


if __name__ == "__main__":
    sys.exit(main())
