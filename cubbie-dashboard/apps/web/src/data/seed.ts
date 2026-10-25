import type { ChatMessage, DiscordMessage, Task } from "@cubbie/shared/types";
import { addDays, fmtDay, fmtTime } from "../lib/dates";

/** Fictional demo data, dated relative to "now" so the demo always looks current. */
export function seedTasks(now = new Date()): Task[] {
  const at = (days: number, h: number, m = 0) => { const d = addDays(now, days); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const ymd = (days: number) => { const d = addDays(now, days); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const created = addDays(now, -14).toISOString();
  const t = (x: Omit<Task, "createdAt" | "updatedAt">): Task => ({ published: true, ...x, createdAt: created, updatedAt: created });

  return [
    // Student
    t({ id: "s1", view: "student", status: "todo", kind: "quiz", course: "STP 420", title: "Quiz 6: Hypothesis testing", dueAt: at(0, 23, 59), points: 20, priority: "high", source: "canvas", sourceId: "canvas:quiz:6601", progress: 0 }),
    t({ id: "s2", view: "student", status: "in_progress", kind: "assignment", course: "CSE 310", title: "Homework 5: Graph algorithms", dueAt: at(1, 23, 59), points: 50, priority: "high", source: "canvas", sourceId: "canvas:asg:31005", progress: 40, notes: "Q1 to Q3 done. Dijkstra proof left." }),
    t({ id: "s3", view: "student", status: "partial", kind: "discussion", course: "ENG 302", title: "Peer review: technical memo", dueAt: at(2, 17, 0), points: 10, priority: "medium", source: "canvas", sourceId: "canvas:disc:8812", progress: 50 }),
    t({ id: "s4", view: "student", status: "todo", kind: "project", course: "CSE 365", title: "Lab 3: Buffer overflow write-up", dueAt: at(3, 23, 59), points: 100, priority: "medium", source: "canvas", sourceId: "canvas:asg:36503", progress: 0 }),
    t({ id: "s5", view: "student", status: "partial", kind: "exam", course: "CSE 310", title: "Midterm 2 study guide", dueAt: at(6, 10, 30), points: null, priority: "high", source: "canvas", sourceId: "canvas:cal:310mt2", progress: 60, notes: "Exam starts at the due time. Study guide is 60% done." }),
    t({ id: "s6", view: "student", status: "todo", kind: "reading", course: "CSE 365", title: "Reading: Ch. 7 Web security", dueAt: null, dueLabel: "No due date", source: "canvas", sourceId: "canvas:page:365ch7", progress: 0 }),
    t({ id: "s7", view: "student", status: "in_progress", kind: "project", course: "ENG 302", title: "Project proposal draft", dueAt: at(-1, 23, 59), points: 40, priority: "high", source: "canvas", sourceId: "canvas:asg:30211", progress: 70 }),
    t({ id: "s8", view: "student", status: "done", kind: "assignment", course: "STP 420", title: "Homework 4", dueAt: at(-2, 23, 59), points: 30, source: "canvas", sourceId: "canvas:asg:42004", progress: 100 }),
    t({ id: "s9", view: "student", status: "done", kind: "assignment", course: "CSE 310", title: "Homework 4: Dynamic programming", dueAt: at(-6, 23, 59), points: 50, source: "canvas", sourceId: "canvas:asg:31004", progress: 100 }),

    // TA / Grader: unavailable counts stay null, student deadlines are not grading deadlines
    t({ id: "g1", view: "grader", status: "todo", kind: "grading", course: "CSE 205", title: "Lab 4: Linked lists", dueAt: null, dueLabel: "Grading deadline not specified", source: "canvas", sourceId: "canvas:asg:20504",
      grading: { section: "All sections", studentsSubmitted: 38, eligibleStudents: 45, needsGrading: 38, studentDueAt: at(-1, 23, 59), gradingDueAt: null } }),
    t({ id: "g2", view: "grader", status: "partial", kind: "grading", course: "CSE 205", title: "Project 2: Inventory system", dueAt: at(2, 17, 0), source: "canvas", sourceId: "canvas:asg:20592", progress: 60, priority: "high",
      notes: "Grading deadline comes from the instructor's TA instructions page.",
      grading: { section: "Sections 1 and 2", studentsSubmitted: 41, eligibleStudents: 44, needsGrading: 17, studentDueAt: at(-4, 23, 59), gradingDueAt: at(2, 17, 0) } }),
    t({ id: "g3", view: "grader", status: "in_progress", kind: "grading", course: "CSE 205", title: "Quiz 5 written portion", dueAt: null, dueLabel: "Grading deadline not specified", source: "canvas", sourceId: "canvas:quiz:20555", progress: 25,
      grading: { section: "All sections", studentsSubmitted: null, eligibleStudents: null, needsGrading: 9, studentDueAt: at(-3, 23, 59), gradingDueAt: null } }),
    t({ id: "g4", view: "grader", status: "todo", kind: "grading", course: "CSE 205", title: "Lab 5: Stacks and queues", dueAt: null, dueLabel: "Students still submitting", source: "canvas", sourceId: "canvas:asg:20505",
      grading: { section: "All sections", studentsSubmitted: 6, eligibleStudents: 45, needsGrading: null, studentDueAt: at(3, 23, 59), gradingDueAt: null } }),
    t({ id: "g5", view: "grader", status: "todo", kind: "task", course: "CSE 205", title: "Office hours: exam review slides", dueAt: at(5, 14, 0), source: "manual", priority: "medium", progress: 0 }),
    t({ id: "g6", view: "grader", status: "done", kind: "grading", course: "CSE 205", title: "Lab 3: Arrays and recursion", dueAt: null, dueLabel: "Graded", source: "canvas", sourceId: "canvas:asg:20503", progress: 100,
      grading: { section: "All sections", studentsSubmitted: 44, eligibleStudents: 45, needsGrading: 0, studentDueAt: at(-8, 23, 59), gradingDueAt: null } }),

    // Job hunt (Cubbridge): application date only when evidenced
    t({ id: "j1", view: "jobs", status: "assessment", kind: "assessment", title: "SQL online assessment", dueAt: at(2, 17, 0), priority: "high", source: "gmail", sourceId: "gmail:northwind-oa",
      job: { company: "Northwind Analytics", role: "Data Analyst Intern", location: "Tempe, AZ", stage: "assessment", applicationDate: ymd(-9), applicationDateEvidence: "Confirmation email states the submission date", assessmentDeadline: at(2, 17, 0), assessmentDeadlineText: "within 72 hours of this email", nextAction: "Finish the SQL assessment", verifiedContacts: 3, calendarState: "created" } }),
    t({ id: "j2", view: "jobs", status: "interview", kind: "interview", title: "Reply with interview availability", dueAt: at(1, 12, 0), priority: "high", source: "gmail", sourceId: "gmail:lumen-int",
      job: { company: "Lumen Health", role: "Software Engineering Intern", location: "Phoenix, AZ", stage: "interview", applicationDate: null, confirmationAt: addDays(now, -15).toISOString(), nextAction: "Reply with availability", followUpAt: at(1, 12, 0), verifiedContacts: 2, calendarState: "none" } }),
    t({ id: "j3", view: "jobs", status: "applied", kind: "follow_up", title: "Follow up with recruiter", dueAt: at(-1, 10, 0), priority: "medium", source: "gmail", sourceId: "gmail:harbor-app",
      job: { company: "Harbor Robotics", role: "Product Analyst Intern", location: "Remote", stage: "applied", applicationDate: ymd(-12), applicationDateEvidence: "Application portal receipt", nextAction: "Send follow-up email (draft ready)", followUpAt: at(-1, 10, 0), verifiedContacts: 4, calendarState: "none" } }),
    t({ id: "j4", view: "jobs", status: "applied", kind: "application", title: "Waiting to hear back", dueAt: at(2, 9, 0), source: "gmail", sourceId: "gmail:saguaro-app",
      job: { company: "Saguaro Credit Union", role: "Business Data Analyst Intern", location: "Mesa, AZ", stage: "applied", applicationDate: ymd(-5), applicationDateEvidence: "Workday confirmation", followUpAt: at(2, 9, 0), nextAction: "Follow up if no reply", verifiedContacts: 1, calendarState: "none" } }),
    t({ id: "j5", view: "jobs", status: "assessment", kind: "assessment", title: "Take-home test", dueAt: null, dueLabel: "Deadline needs confirming", priority: "medium", source: "gmail", sourceId: "gmail:copperline-oa",
      job: { company: "Copperline Games", role: "QA Data Intern", location: "Chandler, AZ", stage: "assessment", confirmationAt: addDays(now, -2).toISOString(), assessmentDeadline: null, assessmentDeadlineText: "within 3 business days", nextAction: "Confirm the exact deadline", verifiedContacts: 0, calendarState: "pending_approval" } }),
    t({ id: "j6", view: "jobs", status: "offer", kind: "application", title: "Decide on offer", dueAt: at(9, 17, 0), priority: "high", source: "gmail", sourceId: "gmail:mesa-offer",
      job: { company: "Mesa Labs", role: "Machine Learning Intern", location: "Scottsdale, AZ", stage: "offer", applicationDate: ymd(-40), applicationDateEvidence: "Handshake receipt", nextAction: "Respond to the offer", verifiedContacts: 2, calendarState: "created" } }),
    t({ id: "j7", view: "jobs", status: "applied", kind: "application", title: "Application received", dueAt: null, dueLabel: "No follow-up set", source: "gmail", sourceId: "gmail:desertsky-app",
      job: { company: "Desert Sky Energy", role: "Data Engineering Intern", location: "Phoenix, AZ", stage: "applied", applicationDate: null, confirmationAt: addDays(now, -3).toISOString(), nextAction: "Find alumni at Desert Sky", verifiedContacts: null, calendarState: "none" } }),
    t({ id: "j8", view: "jobs", status: "closed", kind: "application", title: "Not moving forward", dueAt: null, dueLabel: "Closed", source: "gmail", sourceId: "gmail:bluebird-rej",
      job: { company: "Bluebird Logistics", role: "Analytics Intern", stage: "rejected", applicationDate: ymd(-30), applicationDateEvidence: "LinkedIn Easy Apply receipt", verifiedContacts: 1, calendarState: "none" } })
  ];
}

export function seedChat(now = new Date()): ChatMessage[] {
  const at = (minsAgo: number) => new Date(now.getTime() - minsAgo * 60_000).toISOString();
  const tonight = new Date(now); tonight.setHours(23, 59, 0, 0);
  const lab = addDays(now, -1); lab.setHours(23, 59, 0, 0);
  const oa = addDays(now, 2); oa.setHours(17, 0, 0, 0);
  return [
    { id: "c1", direction: "out", text: "cubbie my week is chaos 😭", at: at(190), status: "read" },
    { id: "c2", direction: "in", text: "on it. let's sort it out 💙", at: at(189) },
    { id: "c3", direction: "in", text: `Due soonest:\n- STP 420 Quiz 6, tonight ${fmtTime(tonight)}\n- CSE 310 HW 5, tomorrow ${fmtTime(tonight)}\n- ENG 302 proposal is a day late\n\nWant a 9 pm check-in every night?`, at: at(189) },
    { id: "c4", direction: "out", text: "yes 9pm", at: at(186), status: "read" },
    { id: "c5", direction: "in", text: "Done. I'll text you at 9 pm with what's due tomorrow.", at: at(186) },
    { id: "c6", direction: "out", text: "what needs grading for 205", at: at(64), status: "read" },
    { id: "c7", direction: "in", text: `CSE 205 — Lab 4\nTo Do: Grade 38 submissions\nStudent submissions due: ${fmtDay(lab)}, ${fmtTime(lab)}\nGrading deadline: Not specified`, at: at(63) },
    { id: "c8", direction: "in", text: `Project 2 also has 17 left to grade for sections 1 and 2, due ${fmtDay(oa)} ${fmtTime(oa)}.`, at: at(63) },
    { id: "c9", direction: "in", text: `Heads up: your Northwind Analytics assessment is due ${fmtDay(oa)}, ${fmtTime(oa)}. The reminder is on your Google Calendar.`, at: at(12) }
  ];
}

export function seedDiscord(now = new Date()): DiscordMessage[] {
  const at = (minsAgo: number) => new Date(now.getTime() - minsAgo * 60_000).toISOString();
  return [
    { id: "d1", channelId: "updates", channelName: "cubbie-updates", author: "Cubbie Board", bot: true, text: "Morning brief: 2 due today, 1 overdue, 38 Lab 4 submissions waiting to be graded.", at: at(300) },
    { id: "d2", channelId: "study", channelName: "study-cse310", author: "maya", text: "anyone starting HW5 Q4 tonight? library 3rd floor at 7", at: at(140) },
    { id: "d3", channelId: "study", channelName: "study-cse310", author: "jordan", text: "down. the Dijkstra proof is rough", at: at(132) },
    { id: "d4", channelId: "updates", channelName: "cubbie-updates", author: "Cubbie Board", bot: true, text: "Follow-up overdue: Harbor Robotics, Product Analyst Intern. The draft is ready in your tracker.", at: at(60) },
    { id: "d5", channelId: "ta", channelName: "cse205-tas", author: "prof-lee", text: "Reminder: Project 2 grades for sections 1 and 2 by Friday 5 pm please.", at: at(45) }
  ];
}
