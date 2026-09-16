"""06-publish staging/promotion against the CURRENT extraction schema (extract_v2), with
no database: calls rebuild.py's in-memory staging step directly.

Covers what the 2026-09 four-school run exposed:

  - rebuild.py read `dates.incident_start_raw`, which the extract_v2 schema replaced with
    the top-level `incident_dates` array, so every real incident failed to stage;
  - Georgia Tech publishes its whole conduct history on two different pages, so the same
    incident is extracted twice. Approving both copies must give ONE public incident with
    ONE set of dates, its staging id frozen at the first copy, and a "Duplicate match"
    link for the second;
  - "Legally required field missing" is recomputed from null _raw fields the way
    04-extract/prompt.md defines them — not from the retired "Not specified" sentinel.

Run with: python tests/test_publish_duplicates.py
"""
import copy
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _load_rebuild():
    spec = importlib.util.spec_from_file_location("job_06_publish_rebuild_dupes",
                                                  ROOT / "jobs" / "06-publish" / "rebuild.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _day(raw, iso):
    one = {"raw": raw, "normalized": iso, "precision": "Day", "year": int(iso[:4]),
           "month": int(iso[5:7]), "academic_term": None}
    return {**{f"start_{k}": v for k, v in one.items()}, **{f"end_{k}": v for k, v in one.items()}}


# Shaped like Georgia Tech's real extraction: violations list as description/findings,
# no investigation or notice dates, alcohol field left blank by the school.
SIGMA_CHI = {
    "organization_name_raw": "Sigma Chi", "organization_name_normalized": "Sigma Chi",
    "organization_type": "Social fraternity or sorority",
    "membership_gender_composition": "All-male", "institutional_recognition_status": "Recognized",
    "description_raw": "Hazing.", "findings_raw": "Hazing.",
    "sanctions_raw": "Disciplinary Probation\nSanction Status: Complete",
    "alcohol_involved": "Not specified", "drugs_involved": "Not specified",
    "determination_status": "Determined hazing",
    "dates": {"investigation_start_date_raw": None, "investigation_start_date": None,
              "investigation_end_date_raw": None, "investigation_end_date": None,
              "notice_date_raw": None, "notice_date": None},
    "incident_dates": [_day("9-05-2024", "2024-09-05")],
    "extraction_confidence": 0.9,
    "flags": [
        {"flag_type": "Legally required field missing", "field_name": "alcohol_involved", "note": None},
        {"flag_type": "Legally required field missing", "field_name": "drugs_involved", "note": None},
        {"flag_type": "Legally required field missing", "field_name": "dates.notice_date_raw", "note": None},
    ],
}

APPROVE = [{"extraction_ref": {"file_hash": "h", "incident_index": 0}, "decision": "approved",
            "reviewer": "test-reviewer", "reviewed_at": "2026-09-16T05:00:00Z", "corrections": [],
            "organization_review": {"decision": "approved", "corrected_organization_type": None,
                                    "corrected_membership_gender_composition": None}}]


def main() -> int:
    rb = _load_rebuild()
    failures, passed = [], []
    state = rb._RebuildState()

    # ── the same incident on two pages, both approved ──
    for page in ("conduct-history", "transparency-report"):
        rb._stage_one_incident(state, f"archive/139755_gt/2026/docs/{page}", f"art_{page}", "139755", 2026,
                               "2026-09-16T04:00:00Z", copy.deepcopy(SIGMA_CHI), 0, "h", APPROVE)

    if len(state.staging_incidents) != 2:
        failures.append(f"current-schema incidents should both stage, got {len(state.staging_incidents)}")
    else:
        passed.append("current-schema incidents stage (no incident_start_raw lookup)")

    first_staging_id = state.staging_incidents[0][0]
    public = list(state.incidents.values())
    if len(public) != 1:
        failures.append(f"same incident on two pages: expected 1 public incident, got {len(public)}")
    elif public[0][2] != first_staging_id:
        failures.append("same incident on two pages: public row's staging_incident_id must stay at the first copy")
    else:
        passed.append("same incident on two pages publishes once, frozen at the first copy")

    linked_dates = [r for r in state.incident_dates if r[2] is not None]
    linked_orgs = [r for r in state.incident_organizations if r[3] is not None]
    if len(linked_dates) != 1 or len(linked_orgs) != 1:
        failures.append(f"public incident should have 1 date row and 1 org link, got {len(linked_dates)} / {len(linked_orgs)}")
    else:
        passed.append("the public incident shows its date and organization once, not twice")
    if len(state.incident_dates) != 2:
        failures.append("both copies should still keep their own (unlinked) staging date rows")

    if [m[3] for m in state.possible_matches] != ["Duplicate match"]:
        failures.append(f"expected exactly one 'Duplicate match' row, got {state.possible_matches}")
    else:
        passed.append("the second copy is recorded as a 'Duplicate match'")

    # ── missing-field flags follow prompt.md ──
    flags = {(t, f) for t, f in rb._recompute_flags(SIGMA_CHI, SIGMA_CHI["flags"], set())}
    expected = {
        ("Legally required field missing", "dates.investigation_start_date_raw"),
        ("Legally required field missing", "dates.investigation_end_date_raw"),
        ("Legally required field missing", "dates.notice_date_raw"),
        ("Legally required field missing", "alcohol_involved"),   # carried forward from the AI
        ("Legally required field missing", "drugs_involved"),     # carried forward from the AI
    }
    if flags != expected:
        failures.append(f"flags: expected {sorted(expected)}, got {sorted(flags)}")
    else:
        passed.append("null _raw dates are flagged; the AI's alcohol/drugs flags carry forward")

    pending = dict(SIGMA_CHI, determination_status="Pending", sanctions_raw=None, flags=[])
    if ("Legally required field missing", "sanctions_raw") in set(rb._recompute_flags(pending, [], set())):
        failures.append("a missing sanction on a Pending incident must not be flagged (prompt.md rule 3)")
    determined = dict(SIGMA_CHI, sanctions_raw=None, flags=[])
    if ("Legally required field missing", "sanctions_raw") not in set(rb._recompute_flags(determined, [], set())):
        failures.append("a missing sanction on a Determined hazing incident must be flagged")
    else:
        passed.append("missing sanctions flagged only for 'Determined hazing'")

    no_end = copy.deepcopy(SIGMA_CHI)
    for k in ("end_raw", "end_normalized", "end_year", "end_month"):
        no_end["incident_dates"][0][k] = None
    no_start = copy.deepcopy(SIGMA_CHI)
    no_start["incident_dates"][0]["start_raw"] = None
    end_flags = {f for _, f in rb._recompute_flags(no_end, [], set())}
    start_flags = {f for _, f in rb._recompute_flags(no_start, [], set())}
    if any("end" in f and "investigation" not in f for f in end_flags) or "incident_dates.start_raw" not in start_flags:
        failures.append(f"incident dates: start must be flagged when null, end never (got {end_flags} / {start_flags})")
    else:
        passed.append("a null incident start is flagged; a null incident end never is")

    # ── the AI's correction-resolved flag still clears ──
    cleared = rb._recompute_flags(SIGMA_CHI, SIGMA_CHI["flags"], {"alcohol_involved"})
    if ("Legally required field missing", "alcohol_involved") in set(cleared):
        failures.append("a carried-forward flag must clear when the reviewer corrected that field")

    # ── null description / null start don't break the id ──
    bare = dict(SIGMA_CHI, description_raw=None, incident_dates=[dict(SIGMA_CHI["incident_dates"][0], start_raw=None)])
    try:
        rb._incident_row_key("139755", bare)
        passed.append("incident_id is computable when description and start date are null")
    except Exception as e:
        failures.append(f"incident_id with null description/start raised {e!r}")

    if failures:
        print("FAIL")
        for f in failures:
            print(f"      {f}")
        return 1
    for p in passed:
        print(f"ok    {p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
