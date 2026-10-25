import type { ReactNode } from "react";

const paths = {
  board: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" /></>,
  list: <><path d="M9 6h12M9 12h12M9 18h12M3 6h1M3 12h1M3 18h1" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 11h18M8 15h2M14 15h2" /></>,
  settings: <><path d="m9 3-.7 2.2-2 .9-2.1-.5-2 3.4 1.5 1.7v2.5L2.2 15l2 3.4 2.1-.5 2 .9L9 21h4l.7-2.2 2-.9 2.1.5 2-3.4-1.5-1.8v-2.5L19.8 9l-2-3.4-2.1.5-2-.9L13 3Z" /><circle cx="11" cy="12" r="3" /></>,
  student: <><path d="m2 8 10-5 10 5-10 5-10-5ZM6 10v7c4 3 8 3 12 0v-7M22 8v8" /></>,
  grader: <><path d="M9 5H5v16h14V5h-4M9 3h6v4H9zM8 14l3 3 5-6" /></>,
  jobs: <><rect x="3" y="7" width="18" height="14" rx="2" /><path d="M8 7V3h8v4M3 12c6 4 12 4 18 0M12 12v4" /></>,
  chat: <path d="M21 11a9 9 0 0 1-9 9H3l2-5a9 9 0 1 1 16-4Z" />,
  discord: <><path d="M8 5 4 6c-2 4-3 8-2 12l5 2 1-3m8-12 4 1c2 4 3 8 2 12l-5 2-1-3M7 7c3-1 7-1 10 0M7 16c3 2 7 2 10 0" /><circle cx="8" cy="12" r="1" /><circle cx="16" cy="12" r="1" /></>
} satisfies Record<string, ReactNode>;
export type IconName = keyof typeof paths;
export function Icon({ name }: { name: IconName }) {
  return <svg className="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
