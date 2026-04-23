// Orthogonal memories. The point of "noise" is that it's NOT engineering,
// NOT decisions, NOT runbooks — it's the random other stuff that lives in
// a real personal memory pool: customer feedback, half-formed ideas,
// reading notes, todos. Tests whether the LLM can navigate WITHOUT
// over-clustering everything as eng-related.

import type { FixtureCategory } from "./types.js";

const NOISE: FixtureCategory = [
  // Customer feedback
  {
    ref: "feedback-search-ux",
    author: "tamer",
    title: "Customer feedback: search results need to show context, not just titles",
    content:
      "Feedback from a paid user: 'when I search for a tag, I get titles " +
      "back but I have to click into each one to remember why I tagged " +
      "it that way. A snippet of matching content would save me 10+ " +
      "clicks per session.' Worth doing post-graph work.",
    tags: ["feedback", "customer", "search", "ux"],
    shared: true,
    created_offset_days: -12,
  },
  {
    ref: "feedback-mobile",
    author: "tamer",
    title: "Customer feedback: dashboard unusable on phone",
    content:
      "Couple of users have asked about mobile. Today the dashboard is " +
      "desktop-only — sidebar takes the whole viewport on a phone. Not a " +
      "near-term priority but logging.",
    tags: ["feedback", "customer", "dashboard", "mobile"],
    shared: true,
    created_offset_days: -20,
  },
  {
    ref: "feedback-trial-conversion",
    author: "van",
    title: "Sales note: trial → paid conversion is 38% in April",
    content:
      "Pulled the numbers for April so far. 23 trials → 9 paid (38%). " +
      "Up from 24% in March. Best signal: users who connect MCP within " +
      "24h convert at 67%. Onboarding focus should be 'get them connected " +
      "fast'.",
    tags: ["sales", "metrics", "conversion"],
    shared: true,
    created_offset_days: -6,
  },

  // Ideas / research notes (personal)
  {
    ref: "idea-voice-input",
    author: "tamer",
    title: "Idea: voice-driven memory capture from phone",
    content:
      "What if memories could be captured by voice from a phone shortcut? " +
      "Whisper transcribes, an LLM tags, posts to API. Could be the " +
      "killer feature for 'I had a thought walking the dog'. Not " +
      "shipping any time soon but parking.",
    tags: ["idea", "product", "mobile", "voice"],
    shared: false,
    created_offset_days: -35,
  },
  {
    ref: "idea-public-share-links",
    author: "tamer",
    title: "Idea: public share links for individual memories",
    content:
      "User wants to share a single memory externally (e.g. as a " +
      "gist-like link). Could be a paid feature. Privacy story is " +
      "important — defaults to off, explicit opt-in per memory, expires " +
      "in 7 days unless extended.",
    tags: ["idea", "product", "sharing"],
    shared: false,
    created_offset_days: -24,
  },
  {
    ref: "reading-notes-graphiti",
    author: "tamer",
    title: "Reading notes: Graphiti's bi-temporal model",
    content:
      "valid_at = when the fact was true in the world. invalid_at = when " +
      "it stopped being true. created_at + expired_at = transaction " +
      "time. Big idea: when 'Van's role changes from Founder to CEO' you " +
      "don't UPDATE — you set invalid_at on the old edge and INSERT a " +
      "new one. History is queryable. Worth stealing for our edges if " +
      "we ever add the memory_edges table.",
    tags: ["reading", "research", "graph", "graphiti"],
    shared: false,
    created_offset_days: -2,
  },

  // Todos / personal
  {
    ref: "todo-update-pricing-page",
    author: "tamer",
    title: "Todo: update pricing page to show private-deploy tier",
    content:
      "Decision shipped (private-deploy is paid, $500+/mo) but the " +
      "pricing page still shows only Personal and Team plans. Add a " +
      "third column. Quick task, do this week.",
    tags: ["todo", "marketing", "pricing"],
    shared: false,
    created_offset_days: -10,
  },
  {
    ref: "todo-loom-script-record",
    author: "tamer",
    title: "Todo: actually record the demo Loom script we wrote",
    content:
      "We have the script (loom-script-core-demo-v1.md) and the production " +
      "guide. Just need to sit down with OBS and record it. Blocking " +
      "outreach. Should take ~90 min including a couple of takes.",
    tags: ["todo", "marketing", "demo", "video"],
    shared: false,
    created_offset_days: -5,
  },

  // Misc — competitor / industry observations
  {
    ref: "comp-mem0-pricing",
    author: "van",
    title: "Competitive note: Mem0 Pro is $249/mo for the graph tier",
    content:
      "Looked at Mem0's pricing page. Their entry tier is free (vector " +
      "only); the knowledge-graph tier requires Pro at $249/month. We're " +
      "well-positioned: our graph approach (Phase 1) ships at no extra " +
      "cost to users, and our briefing UX is something they don't have.",
    tags: ["competitive", "mem0", "pricing"],
    shared: true,
    created_offset_days: -1,
  },
  {
    ref: "industry-mcp-adoption",
    author: "tamer",
    title: "Industry note: MCP is now in 4 major coding tools",
    content:
      "Cursor, Claude Code, Cline, and (as of last week) JetBrains all " +
      "ship native MCP support. Adoption story for us is much easier than " +
      "6 months ago when we had to explain what MCP even was.",
    tags: ["industry", "mcp", "ecosystem"],
    shared: true,
    created_offset_days: -14,
  },
];

export default NOISE;
