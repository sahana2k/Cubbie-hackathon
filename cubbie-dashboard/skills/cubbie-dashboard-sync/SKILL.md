---
name: cubbie-dashboard-sync
description: Sends the student's verified Canvas coursework, TA grading workload and Cubbridge job applications to their Cubbie Dashboard (a Jira-style board on the web). Use for "sync my dashboard", "update my board", "push this to my dashboard", and right after a Canvas Grader Brief or Cubbridge report when the student has a dashboard key saved. Only sends what Cubbie already verified; never invents dates or counts.
---

# Cubbie Dashboard Sync

The student keeps a Cubbie Dashboard: a web board with their classes, grading and job applications next to this
iMessage thread. This Skill sends the facts Cubbie has already verified to that board. It does not read anything
new by itself; it packages results from Canvas, Gmail and the Cubbridge ledger and posts them over HTTPS.

Data goes to the student's own dashboard, which they set up and signed in to. Nothing is sent to anyone else.

## Key

This Skill needs the student's dashboard key, saved in Cubbie as `CUBBIE_DASHBOARD_API_KEY`. The student creates
it on their board under Settings > Cubbie sync > Create key. If it is not saved yet, send the secure link to save it.
Never ask the student to paste the key into the chat. Commands receive the key only when they name it, as below.

The dashboard address is saved with Cubbie's memory as the student's "dashboard API URL" (for example
`https://abc123.execute-api.us-west-2.amazonaws.com`). If it isn't known, ask for it once and remember it.

## When to use

- The student asks to sync or update their dashboard or board.
- Right after a Canvas Grader Brief or Cubbridge report, if the key is saved: offer "Want me to push this to your
  board?" and sync after they say yes. If they say "always", remember that and sync after each report.
- A scheduled check-in that names this Skill (for example "every morning at 7, sync my dashboard with Canvas due
  dates for the next 14 days").

## Steps

1. Gather verified data for the scope the student asked for. Default scope:
   - Student work: read the student's Canvas assignments, quizzes, discussions and exams due in the next 14 days,
     plus anything overdue that isn't submitted. Skip courses where they are staff.
   - Grading: if the student is a TA, grader or IA, follow the Canvas Grader Brief workflow for their staff courses.
   - Jobs: if the Cubbridge ledger exists, run `python3 ../canvas-grader-brief/scripts/pipeline.py export --now <student-ISO-time>`
     from the canvas-grader-brief folder and use its applications and assessments.
   If Canvas is not connected, sync only what is available and tell the student in one line.
2. Build one JSON file in the student's HOME (directory mode 700, file mode 600) shaped like the example below.
   Rules that match the board:
   - `sourceId` is stable per item (`canvas:asg:<id>`, `canvas:quiz:<id>`, `gmail:<message-id>`), so re-syncs update
     cards instead of duplicating them.
   - `view` is `student`, `grader` or `jobs`. Status for student/grader: `todo`, `in_progress`, `partial`, `done`
     (`done` once Canvas shows it submitted or fully graded). Status for jobs: `applied`, `assessment`, `interview`,
     `offer`, `closed`.
   - Unknown counts are `null`, never 0. A student submission deadline goes in `grading.studentDueAt`; only put
     `grading.gradingDueAt` when an explicit staff deadline exists. `dueAt` is null with `dueLabel`
     "Deadline unavailable" or "No due date" as appropriate.
   - Jobs: `job.applicationDate` only with `job.applicationDateEvidence`. Unconfirmed assessment deadlines keep
     `assessmentDeadline: null` and the exact `assessmentDeadlineText`.
   - Timestamps are ISO 8601 with an explicit offset. Use the student's time zone; ask if it is unknown.
   - Never put student names, grades, scores or submission contents in the file.
3. Run from this Skill's folder:

   ```bash
   CUBBIE_DASHBOARD_API_KEY="$CUBBIE_DASHBOARD_API_KEY" python3 scripts/push.py --url "<dashboard API URL>" --input "<path to the JSON file>"
   ```

4. Delete the JSON file after a successful run.

Example input (fictional):

```json
{
  "skill": "canvas-grader-brief",
  "checkedAt": "2026-10-24T12:00:00-07:00",
  "timeZone": "America/Phoenix",
  "sourceLabel": "live_canvas",
  "coverageNotes": [],
  "tasks": [
    {"view": "grader", "status": "todo", "kind": "grading", "title": "Lab 4: Linked lists", "course": "CSE 205",
     "source": "canvas", "sourceId": "canvas:asg:20504", "dueAt": null, "dueLabel": "Grading deadline not specified",
     "grading": {"section": "All sections", "studentsSubmitted": 38, "eligibleStudents": 45, "needsGrading": 38,
                 "studentDueAt": "2026-10-23T23:59:00-07:00", "gradingDueAt": null}}
  ]
}
```

## Replies

One short line, plain text: what was synced and anything skipped. For example:
"Board updated: 9 class items, 4 grading, 8 applications."
If some sources failed, add one line naming them. Do not paste the JSON or the card list into the chat.

## When something fails

| Exit code | Meaning | What to do |
| --- | --- | --- |
| 2 | Bad arguments or unreadable input file | Rebuild the file and try once more |
| 3 | Key missing | Send the secure link to save `CUBBIE_DASHBOARD_API_KEY` |
| 4 | Dashboard unreachable | Say the board isn't reachable right now; try again later |
| 5 | Key rejected | Ask the student to create a new key on the board and save it again |
| 6 | Board rejected the data | Fix the fields the script printed (they follow the rules above) and retry once |
