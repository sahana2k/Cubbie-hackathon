import type { View } from "./types";

export interface ColumnDef { id: string; label: string; wash: "butter" | "sky" | "lilac" | "mint" | "blush"; hint: string }
export interface ViewDef { id: View; label: string; short: string; columns: ColumnDef[]; doneStatuses: string[] }

export const VIEWS: Record<View, ViewDef> = {
  student: {
    id: "student",
    label: "Student",
    short: "Coursework",
    doneStatuses: ["done"],
    columns: [
      { id: "todo", label: "Todo", wash: "butter", hint: "Published · due within 15 days" },
      { id: "in_progress", label: "In progress", wash: "sky", hint: "Working on it" },
      { id: "done", label: "Submit", wash: "mint", hint: "Turned in" }
    ]
  },
  grader: {
    id: "grader",
    label: "TA / Grader",
    short: "Grading",
    doneStatuses: ["done"],
    columns: [
      { id: "todo", label: "Needs grading", wash: "butter", hint: "Submissions waiting" },
      { id: "in_progress", label: "Grading", wash: "sky", hint: "Open in SpeedGrader" },
      { id: "partial", label: "Partly graded", wash: "lilac", hint: "Some sections left" },
      { id: "done", label: "Graded", wash: "mint", hint: "Scores posted" }
    ]
  },
  jobs: {
    id: "jobs",
    label: "Job hunt",
    short: "Jobs",
    doneStatuses: ["offer", "closed", "rejected", "withdrawn"],
    columns: [
      { id: "applied", label: "Applied", wash: "butter", hint: "Waiting to hear back" },
      { id: "assessment", label: "Assessment", wash: "sky", hint: "OA or take-home" },
      { id: "interview", label: "Interview", wash: "lilac", hint: "Confirmed in Cubbie chat" }
    ]
  }
};

export const VIEW_ORDER: View[] = ["student", "grader", "jobs"];
