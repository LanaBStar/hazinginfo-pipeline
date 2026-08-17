# 04-extract: extraction prompt (extract_v2 — v3.0 pipeline)

You are extracting structured data from a single institution's Campus Hazing
Transparency Report (CHTR) filing, published under the Stop Campus Hazing Act.

## What you have

This packet contains:
- `original.pdf` or `original.html` -- the actual document. **Read this as your
  source of truth.** For PDFs, read the file natively (pages, layout, everything) --
  do not rely on `text.txt` for anything other than checking wording.
- `text.txt` -- the plain-text extraction of the original. It may have collapsed
  whitespace or reflowed line breaks. PDFs have `[[page N]]` markers (useful for your
  own navigation; nothing downstream anchors a field to a specific page in v3.0).
- `schema.json` -- the exact JSON Schema your `incidents.json` output must satisfy.
- `metadata.json` -- a stub. Copy it and fill in `model` (your model name) and
  `created` (current UTC timestamp, ISO 8601) when you're done. Leave every other
  field untouched.

## What to produce

Write `incidents.json` in this same directory, matching `schema.json` exactly. Every
`_raw` field is the source text **verbatim** (copy exact wording -- no paraphrasing, typo
correction, or summarizing); every non-`_raw` field is your own interpretation of that
raw text. There are no more `{text, page}` quote objects or character offsets in v3.0 --
`validate.py` only checks schema conformance now, nothing anchors a field to a location.

## Rules (non-negotiable)

1. **Every `_raw`-named field is genuinely nullable and never uses a sentinel string.**
   A field named `_raw` promises verbatim source text -- writing an AI-authored string
   like `"Not specified"` into it would be indistinguishable from real source text and
   breaks that promise. So every `_raw` field (`organization_name_raw`, `description_raw`,
   `findings_raw`, `sanctions_raw`, and every date `_raw` field) is `null` when genuinely
   absent from the source, paired with a `"Required field missing"` flag (see each
   field's own rule for exact conditions -- some, like `sanctions_raw`, are conditional).
   This is different from derived/categorization fields -- `alcohol_involved`/
   `drugs_involved`, `determination_status`, `institutional_recognition_status`,
   `membership_gender_composition`, and every `_precision` field -- which are the AI's
   own interpretation, not verbatim text, so a documented sentinel enum value
   (`"Not specified"`, `"Unknown"`, `"Unknown/Not stated"`, or `"Recognized"` as a
   default) legitimately represents absence there; see each field's own rule for its
   specific sentinel. `organization_type` is also `null` when absent, paired with
   `"Unable to determine organization type"` rather than `"Required field missing"`.
   Never guess a value either way -- an absent field stays absent, it does not get
   invented content.
2. **A missing `organization_name_raw` or `description_raw` is itself meaningful** --
   the Act requires institutions to name the organization and describe the violation, so
   absence of either gets surfaced via a `"Required field missing"` flag, not silently
   accepted. Record `null` for the field itself, don't invent a placeholder.
   `description_raw` in particular is a full narrative displayed to the public, so its
   `null` should render as an explicit UI message ("No description provided") rather
   than any text the AI writes into the field itself.
3. **`findings_raw` and `sanctions_raw`** follow the same null-based pattern as rule 1,
   not a sentinel string. For `findings_raw`: if no finding appears anywhere in the
   source after checking (1) a labeled findings/"found responsible"/"policy violated"
   field, (2) the determination of responsibility within the incident description, and
   (3) the sanctions/outcome text, leave `null` and add a `"Required field missing"`
   flag (`field_name: "findings_raw"`) -- the Act requires the institution's findings as
   part of the violation description. For `sanctions_raw`: if none are stated, leave
   `null`, but only add a `"Required field missing"` flag (`field_name: "sanctions_raw"`)
   when `determination_status` is `"Determined hazing"`. The Act requires sanctions only
   "as applicable" -- a `"Dismissed"` or `"Not specified"` determination legitimately has
   no sanctions to report, and flagging those the same as a genuine gap would bury real
   compliance issues (a `"Determined hazing"` incident with no recorded sanction) in
   noise. Do not flag a missing sanction on a Dismissed/Not specified incident.
4. **Organization name: `organization_name_raw` vs `organization_name_normalized`.**
   `organization_name_raw` is the full text as published (chapter designators, Greek
   letters, "(Inc.)", everything). `organization_name_normalized` strips chapter
   designators (e.g. "Beta Chapter"), legal-entity suffixes ("Inc.", "LLC"), redundant
   type words already captured by `organization_type` ("Fraternity", "Sorority")
   *unless* the word is genuinely part of the org's own name, and
   incident-sequence/report-disambiguation markers the institution appends to
   distinguish multiple incidents against the same organization within one CHTR (e.g.
   "(1st)", "(2nd)", "(#1)", "(#2)" -- confirmed via UT Austin's "Alpha Kappa Psi (1st)"
   and "Alpha Kappa Psi (2nd)", two separate incidents against the same organization in
   the same report). This marker identifies which *incident* it is, not which
   *organization* -- it is never part of the org's actual name and must be stripped the
   same way chapter designators are (e.g. "Alpha Kappa Psi (2nd)" -> "Alpha Kappa
   Psi"). Keep distinctive names/Greek letters intact (e.g. "Alpha Kappa Kappa" stays
   as-is). This applies wherever the type word appears, not only as a bare
   trailing/leading suffix -- a type word preceded by a descriptive modifier ("Christian
   Sorority," "Business Fraternity," "National Sorority") is still a type word, and the
   modifier is still descriptive, not part of the org's distinctive identity: strip the
   whole "[modifier] + [type word]" phrase (e.g. "Sigma Alpha Omega Christian Sorority"
   -> "Sigma Alpha Omega"). Do not stop at checking only the final word for an exact
   match against "Fraternity"/"Sorority" -- confirmed missed via real extraction ("Sigma
   Alpha Omega Christian Sorority" passed through completely unstripped, likely because
   "Sorority" wasn't the literal last token checked against, or the preceding modifier
   made the match logic hesitate). Goal: the same clean name regardless of which
   chapter/institution/incident-sequence reported it -- unitid already identifies the
   institution, and incident-level identity is tracked elsewhere, so neither belongs in
   the org's name. Getting this rule wrong either causes false-negative misses (e.g. two
   incidents against the same fraternity treated as two different organizations because
   "(1st)"/"(2nd)" weren't stripped) or false-positive merges (two distinct orgs
   collapsed into one). If ambiguous -- e.g. the modifier+type phrase might itself be
   the org's chosen self-identifying name rather than a descriptor -- don't guess -- a
   wrong merge or split here causes real matching errors downstream, so flag it
   (`field_name: "organization_name_normalized"`) instead.
5. **`organization_type`** -- pick from the schema's enum based on the org's own
   self-description. This vocabulary was redesigned around *organizational structure and
   purpose*, not demographic composition -- gender is tracked separately via
   `membership_gender_composition` on the organization, so do not use gender as a signal
   here. Work through these checks in order; the first one that applies decides the
   category:
   1. **Greek-lettered self-identification** (the org calls itself a fraternity/
      sorority, or uses a Greek-letter chapter structure). First check the induction
      mechanism: if membership is granted by **merit threshold** (GPA/class standing)
      rather than rush/pledge/intake, and the stated purpose is academic recognition
      rather than social or vocational fraternal community, this is `"Honor society"`
      instead (e.g. Phi Beta Kappa, Tau Beta Pi use Greek letters and chapter structure
      but are Honor Societies, not Fraternity/Sorority). Otherwise, split by primary
      stated purpose: social community/brotherhood-sisterhood -> `"Social fraternity or
      sorority"`; career/professional development, academic advancement in a specific
      field, or ongoing community service (e.g. a business fraternity, nursing
      fraternity, or co-ed service organization like Alpha Phi Omega) -> `"Service or
      professional fraternity or sorority"`. If an org's activities split roughly evenly
      between the two, check how the org or its national parent self-classifies its
      primary purpose (charter/mission language) before defaulting to Social.
   2. **Explicit Corps of Cadets, ROTC, or other military-unit naming or affiliation**
      (including bare alphanumeric unit designations like "A-1," "K-2," "Squadron 17,"
      "C-Battery" -- treat these as valid names, not unclassifiable) -> `"ROTC or other
      military organization"`, regardless of any fraternal ("brotherhood") or
      performance-like language also present. This includes drill teams, color guard,
      exhibition teams, or Ranger Challenge-style competitive teams organized as a
      sub-unit of an ROTC/Corps program (shared command structure, military-affiliated
      advisor/cadre) -- code these as ROTC, not Performing arts organization or Club
      sport, even though the activity itself may resemble those categories. A group
      using fraternal language colloquially without self-identifying as a fraternity or
      military/Corps unit does not qualify here on that basis alone.
   3. **Marching-band-affiliated performance groups** (color guard, drill, dance)
      -> `"Marching band"` if the source itself states the group is part of a marching
      band program; independently-named performance groups (theater, dance, a
      cappella/music, improv, comedy, film-making) -> `"Performing arts organization"`.
      A CHTR incident rarely states organizational affiliation explicitly -- when it
      isn't stated, use the org's own name/self-description as the signal rather than
      guessing at an administrative relationship the source doesn't mention.
   4. **Culturally-based/identity-based orgs**: if Greek-lettered, route through check 1
      above instead (Greek structure decides, not identity focus). Otherwise, an org
      organized around a shared culture, ethnicity, national origin, religion-as-identity,
      or other identity group, whose primary purpose is community/representation/
      belonging for that group (e.g. a Black Student Union, an international students'
      association, an LGBTQ+ student organization) -> `"Culturally-based / identity-based
      organization"`.
   5. **Faith-based framing**: if the org's primary stated function is welcoming/
      mentoring incoming students (e.g. a faith-based freshman camp or peer-mentor
      program), this is `"Other type of organization"` instead, even under religious
      framing -- see check 8. Otherwise, explicit religious/denominational framing in the
      org's own name or stated mission (e.g. "Christian," "Fellowship," "Ministries," a
      named faith tradition) -> `"Faith-based organization"`, unless Greek-lettered
      (check 1 takes priority even with religious affiliation).
   6. **Student government / institutional leadership orgs** -> `"Student government
      or other student leadership organization"` when the org's own name/description
      indicates elected or appointed representative authority (e.g. "Student
      Government," "Senate"). "Leadership" language alone doesn't resolve this against
      Honor society -- a CHTR incident rarely states an org's actual governing
      authority, so lean on explicit representative-body naming rather than inferring
      governance structure the source doesn't mention.
   7. **Campus media** -> `"Campus media organization"` when the org's own name
      identifies it as a media outlet (newspaper, magazine, radio, TV, podcast).
      `"Political organization or social action group"` when the org's name/description
      identifies a political party, ideology, or single-cause advocacy focus instead. A
      CHTR incident rarely describes an outlet's publication history in enough detail
      to judge "ongoing vs. one-off" -- lean on the org's own name/self-description.
   8. **Academic tie without a leadership/selectivity mission** (explicit tie to a
      discipline, major, or career field named in the org's own name or description,
      e.g. "finance," "pre-med," "engineering") -> `"Academic club"`. If a leadership or
      selectivity mission is also present, this moves to `"Honor society"` instead (same
      merit-based tiebreaker as check 1).
   9. **Service/volunteer focus**: Greek letters, chapter structure, and pledging/intake
      -- even with a stated service mission -- route through check 1 (`"Service or
      professional fraternity or sorority"`), not this category. A non-Greek-lettered
      group whose primary, ongoing activity is volunteer/charitable work in the
      community -> `"Community service organization"`.
   10. **Sports, by administering office, not competitive level**: administered by the
       institution's Athletics department (varsity sports, athletics-sponsored
       cheerleading/spirit squads, regardless of NCAA sanctioning) -> `"Varsity athletic
       team"`. Administered outside Athletics (typically Campus Rec/Student Life),
       competing against other institutions, typically with tryouts/rosters and/or
       national governing body affiliation -> `"Club sport"` -- this applies even to a
       highly competitive club team, and a team called "club" but actually
       Athletics-administered is still Varsity. Administered by Campus Rec, competing
       in-house only against other campus groups (dorm/department leagues), with open/
       casual participation and no tryouts required -> `"Intramural or recreation sports
       team"`.
   11. **`"Social club"`** -- use only after ruling out Academic club, Honor society,
       Faith-based organization, and any Greek-letter category above: a shared hobby or
       general social purpose with no academic/career tie, no leadership/selectivity
       mission, and no other more specific match.
   12. **`"Other type of organization"`** -- final residual catch-all, including
       orientation/mentorship programs (freshman camps, peer-mentor programs) explicitly,
       and any organizational form not otherwise represented in this list. Before
       defaulting here, check the org's primary stated function against every other
       category's definition and scope note above, since several (Community service,
       Social club, Culturally-based) are intentionally broad. Leave `null` and flag
       (`"Unable to determine organization type"`) only if genuinely undeterminable --
       never invent a value. Note: a recurring pattern of "Other" classifications for a
       similar organizational type may indicate a gap in this vocabulary worth flagging
       for review, beyond the individual per-incident flag.
6. **`membership_gender_composition`** (`"All-male"|"All-female"|"Mixed/Co-ed"|"Unknown/
   Not stated"`) -- a property of the *organization*, not this specific incident, but
   captured here since this schema has no separate organization object. Reflects the
   organization's own self-identified gender-identity category for membership
   eligibility, not individual members' sex assigned at birth -- a single-gender
   organization that includes transgender members consistent with its stated identity
   (e.g. a fraternity with transgender-male brothers) remains `"All-male"`/`"All-female"`,
   not `"Mixed/Co-ed"`. `"Mixed/Co-ed"` applies only when the org's own membership
   eligibility spans more than one gender identity -- e.g. an org that admits both men
   and women, or a general-interest club with no gender restriction. Do not infer from
   organization name alone: many orgs using "fraternity" in their name are explicitly
   co-ed (e.g. Alpha Kappa Psi, Delta Sigma Pi, and other professional/business
   fraternities routinely admit members of any gender) -- but "sorority" is a much
   stronger single-gender signal, since a historically women's org that opens to men
   typically disaffiliates and rebrands away from "sorority" entirely rather than keeping
   the label. Check org name against known Panhellenic/IFC naming patterns first (cheap
   heuristic); escalate to a lookup only when genuinely ambiguous (e.g. service
   fraternities, spirit groups), and never re-resolve per incident for an org already
   coded. Default to `"Unknown/Not stated"` when source text doesn't clearly indicate
   composition -- do not leave blank and do not guess from name alone. No flag is written
   for this default; it is expected to be the common case given how rarely CHTR text
   states this explicitly.
7. **`institutional_recognition_status`** (`"Recognized"|"Unrecognized/Underground"|
   "Formerly Recognized - Lost Recognition"|"Unknown/Not Stated"`) -- whether the
   organization was formally recognized by and affiliated with the institution *at the
   time of this specific incident*, independent of `organization_type`. This is a
   cross-cutting, time-variant attribute captured per-incident, not per-organization: the
   same organization can be Recognized for one incident and Formerly Recognized for a
   later one (e.g. after losing its charter), so do not assume a single fixed status for
   an org across multiple incidents. An unrecognized or underground group is still coded
   per its actual function under `organization_type` (e.g. a Social fraternity that lost
   recognition is still `"Social fraternity or sorority"` under `organization_type`) --
   this field tracks recognition separately. Default to `"Recognized"` when source text
   does not address recognition status at all -- CHTR-reported organizations are presumed
   institutionally recognized absent explicit evidence otherwise; no flag needed for this
   default. Look for explicit source-text language dated at or before the incident (e.g.
   "the fraternity, which had already lost its charter in [prior year]," "operating
   without university sanction at the time") before coding anything other than
   Recognized. Do not code `"Formerly Recognized - Lost Recognition"` if recognition was
   revoked *as a consequence of* the incident being coded -- at the moment that incident
   occurred, the org was still Recognized; only a *later* incident (after the loss took
   effect) would be Formerly Recognized. Do not assume Unrecognized status merely because
   an org sounds secret, underground, or is informally named -- this requires explicit
   textual evidence. Reserve `"Unknown/Not Stated"` for cases where source text actively
   raises the question of recognition but leaves it genuinely ambiguous or conflicting
   (e.g. text disputes whether the org was sanctioned) -- not for mere silence, which
   defaults to Recognized. No flag is needed for `"Unknown/Not Stated"` -- like
   `membership_gender_composition`'s `"Unknown/Not stated"`, this is a legitimate
   resolution state, not an error condition requiring review.
8. **`alcohol_involved` / `drugs_involved`** are independent (`"Yes"|"No"|"Not
   specified"|"Unable to determine - Unclear reporting"`), populated separately even when
   the source presents them as one combined field. Three source patterns: (a) separate
   per-substance fields -- map each directly; (b) one combined "alcohol and/or drugs"
   field -- a combined affirmative does **not** confirm both substances: first try to
   allocate from surrounding description/findings/sanctions text, setting only the
   substance(s) actually named to `"Yes"`. If allocation succeeds for one substance but
   the other is simply never mentioned, the unconfirmed substance stays `"Not
   specified"`, not `"No"` -- this is ordinary silence, not ambiguity. If allocation
   fails **entirely** -- the combined field is affirmative but no surrounding text names
   alcohol, drugs, or either specifically -- set **both** `alcohol_involved` and
   `drugs_involved` to `"Unable to determine - Unclear reporting"` rather than `"Not
   specified"`: the combined "Yes" tells you at least one substance was involved, which
   is a stronger claim than ordinary silence, but the source's own reporting doesn't let
   you determine which. If the combined field is affirmative, **always** add an
   `"Alcohol/drugs review needed"` flag regardless of whether you could allocate -- a
   combined "Yes" is structurally ambiguous even when you're confident. A combined
   `"No"` needs no flag and no `"Unclear..."` value -- "not (A or B)" unambiguously means
   neither substance was involved, so both fields resolve cleanly to `"No"`. (c) stated
   only in narrative text, no labeled field -- read it from there; flag only if genuinely
   unrecoverable. Bar for inferring `"Yes"` from narrative alone: only an unambiguous
   statement of use/intoxication ("found intoxicated," "vomiting from drinking," a stated
   blood alcohol level) -- not adjacent scene-setting ("party," "tailgate") without
   explicit evidence of actual use. Plain silence -- the source, across all three
   patterns above, never addresses alcohol/drugs involvement at all, resolving to
   `"Not specified"` -- also gets a `"Required field missing"` flag
   (`field_name: "alcohol_involved"` or `"drugs_involved"` respectively). This is a
   per-incident data point the Act requires, so unaddressed silence deserves reviewer
   attention -- distinct from `"Alcohol/drugs review needed"`, which is reserved for the
   combined-affirmative-unallocated case only, not plain silence.
9. **`determination_status`** -- the institution's own determination: `"Pending"`
   (investigation ongoing, no finding yet), `"Determined hazing"`, `"Dismissed"`, or
   `"Not specified"` if the document doesn't state one. If genuinely unclear which
   applies, use `"Not specified"` and add a `"Determination unclear"` flag rather than
   guessing.
10. **Dates.** `investigation_start_date`/`investigation_end_date`/`notice_date` (under
    `dates`) are single per-incident facts -- an investigation happens once, notice is
    given once. The incident's own occurrence date(s) are different: a hazing pattern
    can recur on genuinely separate, non-consecutive occasions (e.g. "Fall 2022, Fall
    2023, and Fall 2024"), which one start/end pair can't represent without either
    inventing a false continuous span or losing information. That's what `incident_dates`
    (a top-level array, sibling to `dates`) is for -- one entry per genuinely distinct
    occurrence, each with its own start/end/precision/year/month/academic_term. Always
    emit at least one entry, even if every field in it ends up `null`.

    **Deciding how many `incident_dates` entries to emit:**
    - **One entry, single occurrence**: a single date or a single continuous range
      ("September 1, 2022 to September 15, 2025" -- one ongoing pattern of conduct).
    - **One entry, recurrence contained within one stated period**: the source
      describes recurrence ("hazed weekly," "occurred several times") but frames it as
      happening within one named period and gives no separate dates for each occurrence
      ("throughout the Fall 2025 semester"). This is still one entry -- the named
      period is the boundary the source actually gave you. Set `end_year`/`end_month`/
      `end_academic_term` equal to the corresponding `start_*` fields (the period is
      its own end), and `end_raw` to the same text as `start_raw` if the source doesn't
      separately word the end. Do not leave this case `null`-and-flagged -- nothing is
      actually missing; the source bounded it, just not at Day precision.
    - **Multiple entries**: the source names genuinely separate, non-consecutive
      occasions (different terms, different years, an explicit list of dates that
      aren't a contiguous range). Emit one `incident_dates` entry per named occasion.
      Do not collapse these into a single start/end pair -- doing so falsely implies
      one continuous span when the source actually described distinct recurring events.
    - **Open-ended, genuinely unresolved**: the source indicates the pattern began at
      some point and continued, but never gives any closing information at all (no
      period, no later date, nothing). This is the only case that gets `null` + a
      `"Required field missing"` flag on the end side -- see below.

    **Per-field rules within each `incident_dates` entry** (same rules apply
    symmetrically to `start_*` and `end_*`):
    - **`start_raw` / `end_raw`**: verbatim source text, or `null` if genuinely absent --
      never a sentinel string (see rule 1). Look for labels like "Date of Incident,"
      "Incident Date(s)," or a date/range embedded in the incident's own heading; if the
      incident description contains the only date mention, extract it from there. If a
      range is given ("March 3-5, 2024"), the earlier date is `start_raw`, the later is
      `end_raw`. If `start_raw` is genuinely absent anywhere in the source, leave `null`
      and add a `"Required field missing"` flag (`field_name: "incident_dates.start_raw"`)
      -- the Act requires the date the incident was alleged to have occurred.
    - **`start_precision` / `end_precision`**: `"Day"|"Month"|"Academic term"|
      "Academic year"|"Year"|"Unknown"`, reflecting exactly how precisely the source
      states it -- never infer finer precision than what's written (don't invent
      `"Day"` from a source that only says "Fall 2025"). If a date term doesn't map to
      a recognizable calendar value at all, use `"Unknown"` and add an `"Unrecognized
      date term"` flag rather than guessing. A single year number explicitly labeled as
      an academic year (e.g. "the 2024 academic year") is `"Academic year"` precision,
      not `"Year"` -- the explicit label decides this, not the presence of a hyphenated
      range. Reserve `"Year"` strictly for a bare year number with no term or
      academic-year language attached.
    - **`start_normalized` / `end_normalized`**: a real date value **only when
      precision is `"Day"`**. For every other precision, leave `null` -- do not anchor
      a coarse-precision date to any fabricated day/month (e.g. the 1st of a stated
      month, or a fixed date for a named term). Anchoring conventions were tried and
      rejected: they varied too much school-to-school (semester vs. quarter vs.
      trimester calendars) to be reliable, and a fabricated date looks authoritative
      even when it's a guess. `start_year`/`start_month`/`start_academic_term` (and
      their `end_*` counterparts) exist specifically to carry whatever partial date
      information the source actually supports at non-Day precision, without
      fabricating a full date.
    - **`start_year` / `end_year`**: the calendar year as an integer, populated
      whenever any year is determinable regardless of precision (Day down through
      Year). For an academic-year span (e.g. "2024-2025"), use the first year stated
      (2024). Leave `null` only when the corresponding `_raw` field is itself `null`.
    - **`start_month` / `end_month`**: integer 1-12, populated only at Day or Month
      precision -- never guess a month from a term name (e.g. never infer September
      for "Fall"). `null` at Academic term, Academic year, Year, or Unknown precision.
    - **`start_academic_term` / `end_academic_term`**: `"Fall"|"Spring"|"Summer"|
      "Winter"`, populated only at Academic term precision and only when the source
      names one of those four terms or a recognized synonym -- map `"Autumn"` to
      `"Fall"` (common in international/British-style usage); store `"Fall"`, never
      `"Autumn"`. A term name outside this list (including unrecognized synonyms) stays
      `null` here (the `"Unrecognized date term"` flag on `_precision` already covers
      that gap) -- don't guess the closest match. `null` at every other precision
      level, including Academic year (a year span names no single term).
    - **Single-day end mirroring -- Day precision only**: when `start_precision` is
      `"Day"` and no separate end is reported, mirror every `start_*` field's actual
      value into the matching `end_*` field (`end_raw` = `start_raw`, `end_normalized`
      = `start_normalized`, `end_precision` = `start_precision`, `end_year` =
      `start_year`, `end_month` = `start_month`, `end_academic_term` =
      `start_academic_term`) -- this is copying real values, not inventing a sentinel,
      so no flag is needed. Month, Academic term, Academic year, and Year precision
      incidents can never qualify as single-day, so they never use this mirroring path
      -- they follow the contained-recurrence or open-ended-unresolved handling above
      instead.
    - **Open-ended, unresolved end** (see the segmentation guidance above): leave every
      `end_*` field `null` and add a `"Required field missing"` flag
      (`field_name: "incident_dates.end_raw"`).

11. **Investigation and notice dates** (`dates.investigation_start_date_raw`,
    `dates.investigation_end_date_raw`, `dates.notice_date_raw`, and their normalized
    counterparts) are single per-incident facts, not part of the `incident_dates`
    array -- `notice_date` (when the org was formally told of the outcome) is distinct
    from `investigation_end_date` (when the finding was made), though some institutions
    report them together with one shared date; only merge them if the source explicitly
    does. Every `_raw` field here follows rule 1 -- genuine `null`, never a sentinel
    string.
    - **`investigation_start_date_raw` / `investigation_end_date_raw`**: look for labels
      like "Investigation Initiated," "Date Investigation Began," "Investigation
      Concluded," "Date of Responsible Finding," or a combined "Dates of Investigation:
      A - B" range (A -> start, B -> end). If genuinely absent anywhere in the source,
      leave `null` and add a `"Required field missing"` flag
      (`field_name: "dates.investigation_start_date_raw"` or
      `"dates.investigation_end_date_raw"`) -- investigation dates are legally required
      under the Act, so absence here is a compliance gap worth reviewer attention.
    - **`notice_date_raw`**: look for a label indicating when the organization was
      formally informed of the outcome/violation/charges/sanctions -- not just labels
      containing the literal word "notice." Resolve in this order before concluding
      it's absent: (1) a separately-labeled notice field matching that pattern; (2) the
      merge case -- if the source combines notice with the finding/resolution date
      under one label ("Date of Responsible Finding and Notice to Organization,"
      "Resolution Date and Notice to Organization"), use that single date for both
      `notice_date` and `investigation_end_date`, unless two distinct dates are given;
      (3) narrative text (`description_raw`, `sanctions_raw`, `findings_raw`) for an
      explicit statement of when the organization was notified. Only if all three
      fail, leave `null` and add a `"Required field missing"` flag
      (`field_name: "dates.notice_date_raw"`) -- notice date is legally required, so a
      genuinely unrecoverable value after exhausting all three resolution steps is a
      compliance gap, not ordinary silence. Do not flag on first absence -- work through
      the resolution order first. Many institutions genuinely have no notice-to-
      organization field at all (e.g. UT Austin, which labels only conduct-process-
      resolution, investigation-initiated, report-to-institution, and incident-date --
      no notice field). Do not treat a differently-purposed date as a stand-in just
      because no better candidate exists -- "Date of Report to Institution," for
      example, is when the initial complaint was received, the opposite direction of
      organizational notice, and must not be mapped here.

12. **`zero_incidents_statement`** (on `document`, not on any incident) is for the case
   where the report explicitly states there were zero incidents in the period -- quote
   the document's own statement verbatim. Leave `null` if the report describes one or
   more incidents, **or** if the page shows no incidents and no explicit zero-statement
   either -- this is common and does not mean the page is wrong or that `is_chtr`
   should be `false` (see rule 16): many institutions' CHTR pages simply show an empty
   incident table/section with no fields populated when there is nothing to report,
   rather than writing an explicit sentence saying so. A bare page with nothing to
   quote is still `is_chtr: true`, `incidents: []`, `zero_incidents_statement: null`.
13. **`extraction_confidence`** (per incident, 0.0-1.0) is your own calibrated
   self-assessment of this specific incident's extraction, not the whole document's. Be
   honest, not optimistic -- this drives which incidents a human reviewer looks at more
   carefully.
14. **`flags`** is a structured array, not free text: each entry is
    `{"flag_type": "...", "field_name": "...", "note": "..."|null}` using exactly the
    `flag_type` values `schema.json` defines. Add one entry per distinct condition, even
    within the same incident (e.g. a missing organization *and* an unclear
    determination is two flag entries, not one). `note` is optional context, not a
    substitute for choosing the right `flag_type`.
15. **Do not add fields.** Never add: a hazing-type taxonomy, a sanction-severity level,
    `location` (on/off-campus), `is_aggravated`, or `date_reported`. `schema.json`
    rejects unknown fields, but don't even attempt it -- these are deliberately excluded
    from this pipeline (they can be computed later, downstream of human verification, if
    ever wanted).
16. **`is_chtr`**: the confidence behind this decision depends on what kind of document
    you're actually holding, and that's not always the same thing. `01-discover`'s human
    confirmation applies to the institution's CHTR **index URL** itself -- if this
    document *is* that confirmed page, lean toward `true` even when it's sparse or
    empty (see rule 12), and reserve `false` for content that, once read, clearly turns
    out unrelated (a redirect, a login wall, a broken/placeholder page). But if this
    document was reached by *crawling out* from that index page -- a linked PDF or
    sub-page the index page pointed to, rather than the confirmed page itself -- that
    link was never individually human-verified, and it can genuinely be the wrong
    document entirely (a course catalog, an unrelated PDF, some other page the crawler
    followed by mistake). For a crawled-out document, judge `is_chtr` on the document's
    own content the normal way, with no presumption of correctness inherited from the
    index page it came from. If you cannot tell from the packet which case you're in,
    treat it as the crawled-out case (the more skeptical read) rather than assuming
    confirmation you don't actually have evidence for. When `false`, `incidents` must be
    `[]` and every `document` field should be `null` unless the document genuinely
    states it for a non-CHTR reason.

    Do not confuse "this isn't a CHTR" with "this is a CHTR but I can't see the
    incident-level detail." If a page explicitly self-identifies as a hazing
    transparency report under the Act (or a state-law equivalent) **and** states a
    nonzero violation/incident count for the reporting period, that is `is_chtr: true`
    even if no itemized per-incident narrative is visible in the text you were given --
    a summary sentence like "there was 1 violation of University Policy related to
    hazing" is itself evidence a real incident exists, whether or not you can currently
    see its details (the detail may be behind a collapsed/expandable section that
    didn't render into your source text). In that case, still emit `is_chtr: true`;
    include a best-effort incident entry with whatever is actually stated (e.g. the
    reporting period, that this is one of N reported violations); every `_raw`-named
    field that has nothing to hold stays `null`, and every field with a documented
    default (`alcohol_involved`/`drugs_involved`/`determination_status` ->
    `"Not specified"`, `institutional_recognition_status` -> `"Recognized"`,
    `membership_gender_composition` -> `"Unknown/Not stated"`, `incident_dates` -> one
    entry with every subfield `null` and both `_precision` fields `"Unknown"`) resolves
    to that default, same as any other incident with missing information -- do not
    write literal `null` into a field whose schema type doesn't allow it. Add a
    `"Required field missing"` flag noting that incident-level detail was not
    recoverable from the text you were given. Only use `is_chtr: false` when the
    document itself gives no indication a hazing violation was ever reported -- not
    merely when the detail is thin or hard to find.
17. **Segmentation is your job, but don't force it.** Each distinct incident described
    in the report is one entry in `incidents`. If the document is ambiguous about
    whether something is one incident or two, extract your best reading and flag it if
    genuinely uncertain -- a human reviewer checks segmentation, not you.

## If you can't complete this packet

If the original is unreadable, corrupted, or you cannot form an opinion on `is_chtr`,
still write your best-effort `incidents.json` (even `{"is_chtr": false, "incidents":
[], ...}` with everything else null is valid) rather than leaving the packet
unfinished -- `validate.py` archives whatever you produce, valid or not, so the
document isn't silently skipped.
