import type { View } from "@cubbie/shared/types";

export interface Suggestion { label: string; prompt: string; syncJobs?: boolean }
export const COMPOSER_PLACEHOLDER: Record<View, string> = {
  student: "Ask about your coursework…", grader: "Ask about your grading workload…", jobs: "Ask about your applications…"
};
const jobFormat = ' Use separate plain-text blocks with Company:, Role:, Status:, and Status evidence:. Status must be explicitly verified as Applied, Assessment, Interview, Rejected, Withdrawn, or Offer; omit applications with unknown status. Include requisition IDs if known, and verified assessment/interview dates with time zones. Do not infer a status from a company mention.';
export const SUGGESTIONS: Record<View, Suggestion[]> = {
  student: [
    { label: "Due this week", prompt: "Show published coursework due this week in my current student courses, with course names and deadlines in Arizona time." },
    { label: "Due tomorrow", prompt: "What coursework is due tomorrow in my current student courses? Use verified Canvas deadlines in Arizona time." },
    { label: "Plan my coursework", prompt: "Help me prioritize the published coursework due in my current courses over the next 15 days." }
  ],
  grader: [
    { label: "Needs grading", prompt: "Show assignments needing grading in my current TA/grader courses, with verified pending counts." },
    { label: "Upcoming deadlines", prompt: "Show upcoming deadlines in my current TA/grader courses. Distinguish student submission deadlines from explicit grading deadlines." },
    { label: "Grading workload", prompt: "Summarize my grading workload by current TA course using verified Canvas assignment and To Do data." }
  ],
  jobs: [
    { label: "Sync applications", prompt: "Check all accessible job-application context in my connected Gmail and refresh my confirmed application statuses." + jobFormat, syncJobs: true },
    { label: "Assessment updates", prompt: "Check my connected Gmail for confirmed assessment invitations and deadline updates for my applications. Include any rejection updates for those applications." + jobFormat },
    { label: "Interview updates", prompt: "Check my connected Gmail for confirmed interview invitations, schedules, and status changes for my applications." + jobFormat }
  ]
};
