# OMNIS Domain Map

## Core Domains

```text
OMNIS
│
├── DIGITAL HUMAN
│   ├── Character
│   ├── Life & World
│   ├── Appearance & Continuity
│   ├── Emotion & Behavior
│   ├── Knowledge & Expertise
│   ├── Memory
│   ├── Relationships
│   ├── Agency
│   └── Experience & Learning
│
├── INTELLIGENCE
│   ├── Brain
│   ├── Knowledge Graph
│   ├── RAG
│   ├── Agent Mesh
│   ├── Orchestrator
│   ├── Scheduler
│   └── Evaluation
│
├── AUTOMATION
│   ├── Workflow Engine
│   ├── Event Bus
│   ├── Task Queue
│   └── State Machines
│
├── MEDIA
│   ├── Research
│   ├── Strategy
│   ├── Script
│   ├── Storyboard
│   ├── Voice
│   ├── Visuals
│   ├── Video
│   ├── Editing
│   ├── QA
│   ├── Thumbnail
│   ├── SEO
│   └── Publishing
│
├── SOCIAL
│   ├── Platform Adapters
│   ├── Comments
│   ├── DMs
│   ├── Community
│   └── Distribution
│
├── AUDIENCE
│   ├── Audience Graph
│   ├── Demand
│   ├── Sentiment
│   ├── Loyalty
│   ├── Requests
│   └── Opportunity Scoring
│
├── BUSINESS
│   ├── Analytics
│   ├── Experimentation
│   ├── Growth
│   ├── Brand
│   └── Revenue
│
└── PLATFORM
    ├── Control Plane
    ├── Identity & Access
    ├── Data
    ├── AI Model Layer
    ├── Integrations
    ├── Security
    ├── Observability
    └── Infrastructure
```

## Dependency Direction

```text
UI
 ↓
Application Services
 ↓
Domain
 ↓
Contracts / Events
 ↓
Infrastructure Adapters
```

Domain code must not import UI code or concrete infrastructure providers.

## Ownership Principle

Each persistent piece of state has one authoritative owner. Other domains consume it through contracts, queries or events rather than maintaining competing copies.
