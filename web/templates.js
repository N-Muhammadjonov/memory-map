/** Built-in note templates, profession packs (Smart Onboarding), and local date helper. */

export function todayISO() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export const NOTE_TEMPLATES = [
  {
    id: "daily",
    icon: "📅",
    role: "General",
    name: "Daily note",
    tags: ["Daily"],
    title: () => `Daily note — ${todayISO()}`,
    body: () => `---
date: ${todayISO()}
status: active
tags: [Daily]
---

# ${todayISO()} — Daily plan

> [!tip] Focus
> What is the most important result today?

## Tasks
- [ ] First priority
- [ ] Second priority
- [ ] Review the day

## Notes
-

## Related notes
- [[]]
`,
  },
  {
    id: "study",
    icon: "🎓",
    role: "Student",
    name: "Study note (Feynman + FSRS)",
    tags: ["Study", "Notes"],
    title: () => `Study note — ${todayISO()}`,
    body: () => `---
date: ${todayISO()}
category: Study
mastery: learning
---

# Topic

**Explanation** — Explain the idea in plain language.

## Flashcards (auto-detected by FSRS)
- **Key concept**: Concise definition here
- What is the main tradeoff? :: Explain the answer here

## Core concepts
| Concept | Definition | Example |
| --- | --- | --- |
| Main idea | ... | ... |

## Practice
- [ ] Work through an example
- [ ] Review in FSRS Flashcards
`,
  },
  {
    id: "dev-rfc",
    icon: "💻",
    role: "Developer",
    name: "Architecture RFC & Runbook",
    tags: ["Engineering", "RFC"],
    title: () => `RFC — ${todayISO()}`,
    body: () => `---
date: ${todayISO()}
status: doing
priority: high
---

# Technical RFC

## Problem & Goals
- What are we solving?

## Architecture Diagram
\`\`\`mermaid
sequenceDiagram
Client->>API: POST /v1/sync
API->>Vault: Verify signature
Vault-->>Client: 200 OK
\`\`\`

## Implementation Checklist
- [ ] Schema & migrations
- [ ] Unit & integration tests
- [ ] Rollback plan
`,
  },
  {
    id: "research",
    icon: "🔬",
    role: "Researcher",
    name: "Literature & Experiment Log",
    tags: ["Research", "Paper"],
    title: () => `Research — ${todayISO()}`,
    body: () => `---
date: ${todayISO()}
type: paper
status: doing
---

# Hypothesis & Literature Review

## Hypothesis
- State the testable claim [^1].

## Experiment Results
| Run | Metric | Value | Notes |
| --- | --- | --- | --- |
| Baseline | Accuracy | 0.82 | Control |

## Next Steps
- [ ] Validate edge cases
- [ ] Import BibTeX references

[^1]: Author (Year). Paper Title. Venue.
`,
  },
  {
    id: "crm",
    icon: "💼",
    role: "Business",
    name: "Client CRM & Project Proposal",
    tags: ["Business", "CRM"],
    title: () => `Client CRM — ${todayISO()}`,
    body: () => `---
date: ${todayISO()}
type: client
status: doing
priority: high
---

# Client / Account Overview

- **Contact:** Name · Email
- **Stage:** Discovery / Proposal / Active
- **Value:** $0

## Deliverables & Timeline
- [ ] Scope sign-off
- [ ] First milestone delivery
- [ ] Final handoff & invoice
`,
  },
  {
    id: "writer",
    icon: "✍️",
    role: "Writer",
    name: "Article & Story Draft",
    tags: ["Writing", "Draft"],
    title: () => `Draft — ${todayISO()}`,
    body: () => `---
date: ${todayISO()}
status: doing
wordGoal: 1000
---

# Working Title

> [!note] Core Thesis
> One sentence summarizing why the reader should care.

## Outline
1. Opening hook
2. Core argument & evidence
3. Closing takeaway

## Draft
Start writing here…
`,
  },
  {
    id: "confidential",
    icon: "🛡️",
    role: "Medical / Legal",
    name: "Confidential Case / Intake Log",
    tags: ["Confidential", "Case"],
    title: () => `Case Log — ${todayISO()}`,
    body: () => `---
date: ${todayISO()}
classification: local-encrypted-only
status: todo
---

# Case Summary (AES-256 Local Only)

- **Reference ID:** —
- **Key Dates:** ${todayISO()}

## Chronology & Evidence
-

## Follow-up Actions
- [ ] Verify documents
- [ ] Prepare encrypted transfer ZIP if needed
`,
  },
  {
    id: "roadmap",
    icon: "↗",
    role: "Planning",
    name: "Course / Project Roadmap",
    tags: ["Roadmap"],
    title: () => `Roadmap — ${todayISO()}`,
    body: () => `# Roadmap goals

## Phase 1 — Foundations
- [ ] Define the outcome and choose a source
- [ ] Complete the first milestone

## Phase 2 — Practice
- [ ] Build a working prototype
- [ ] Document what worked

## Phase 3 — Review
- [ ] Verify against original goal
- [ ] Publish or archive
`,
  },
];

export const PROFESSION_PACKS = [
  {
    id: "student",
    name: "Student & Teacher",
    desc: "Feynman study notes, FSRS flashcards, exam roadmap",
    notes: () => [
      {title: `Study Hub — ${todayISO()}`, tags: ["Study"], body: NOTE_TEMPLATES.find(t => t.id === "study").body(), useAvailableTitle: true},
      {title: `Exam Roadmap — ${todayISO()}`, tags: ["Roadmap", "Study"], body: NOTE_TEMPLATES.find(t => t.id === "roadmap").body(), useAvailableTitle: true},
    ],
  },
  {
    id: "developer",
    name: "Developer & Engineer",
    desc: "Architecture RFC, Mermaid Sequence diagrams, runbooks",
    notes: () => [
      {title: `System Architecture RFC`, tags: ["Engineering", "RFC"], body: NOTE_TEMPLATES.find(t => t.id === "dev-rfc").body(), useAvailableTitle: true},
    ],
  },
  {
    id: "researcher",
    name: "Scientist & Researcher",
    desc: "Literature review, experiment log, BibTeX & footnotes",
    notes: () => [
      {title: `Literature Review Hub`, tags: ["Research", "Paper"], body: NOTE_TEMPLATES.find(t => t.id === "research").body(), useAvailableTitle: true},
    ],
  },
  {
    id: "business",
    name: "Business, PM & Freelancer",
    desc: "Client CRM, project milestones, Gantt & Kanban workflow",
    notes: () => [
      {title: `Client CRM Pipeline`, tags: ["Business", "CRM"], body: NOTE_TEMPLATES.find(t => t.id === "crm").body(), useAvailableTitle: true},
    ],
  },
  {
    id: "writer",
    name: "Writer & Journalist",
    desc: "Daily word goals, outlines, DOCX & EPUB publishing",
    notes: () => [
      {title: `Article Draft — ${todayISO()}`, tags: ["Writing"], body: NOTE_TEMPLATES.find(t => t.id === "writer").body(), useAvailableTitle: true},
    ],
  },
  {
    id: "confidential",
    name: "Medical, Legal & Private",
    desc: "Zero-cloud AES-256 case logs & encrypted transfer workflow",
    notes: () => [
      {title: `Confidential Case Log`, tags: ["Confidential"], body: NOTE_TEMPLATES.find(t => t.id === "confidential").body(), useAvailableTitle: true},
    ],
  },
];
