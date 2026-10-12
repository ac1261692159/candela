# CDD: Charter-Driven Development

**English** | [中文](CDD-methodology.zh-CN.md)

[README](README.md) · [README（中文）](README.zh-CN.md)

> Charter-Driven Development · an engineering method for long-running autonomous AI development
>
> Written 2026-10-10. Source: practice on the Candela project and the discussion that produced this method.
> This document describes the method and the design reasons. It does not replace the operating rules in `AGENTS.md`, and it does not add hats, approval requirements, or runtime contracts.

**Organize the AI with a charter. Accept the code with evidence.**

## 1. Definition

CDD (Charter-Driven Development) uses a versioned project charter as the governance entry. It turns role boundaries, architecture red lines, design preconditions, and acceptance requirements into standing rules. Within the authority it has been given, the AI does design, implementation, and delivery. Code, tests, deploy, and runtime evidence decide whether the result holds. What the project learns is written back into the rules and the checks.

In Candela, `AGENTS.md` is the charter. The method also depends on product and architecture documents, executable models and config, check scripts, acceptance records, and a person's decision. A long instruction file by itself is not CDD.

**A Skill answers "how do we do this kind of work well." CDD answers "how is the project governed."** A Skill helps the AI apply domain knowledge. CDD states the duty, the authority, the boundary, the preconditions, and the definition of done. Used together, domain skill operates inside the project's rules.

Candela's background is fully AI-written development: a person sets the goal, makes the consequential decisions, and revises the governance rules; the AI does the development work. That is the setting. It does not take the person off the hook, and it does not mean this document has independently audited every historical commit.

CDD shares a foundation with spec-driven development (SDD) and can be used with it. CDD is the name this project uses. It does not claim to have invented charters, role splits, ratchets, or evidence-based acceptance, and it does not claim the name or the abbreviation is exclusive.

## 2. Why a project charter

An AI can implement a local request quickly. A long-lived project also has to keep every change inside a shared boundary. Across sessions, requirements, decisions already made, risks, and deploy experience are easy to lose. To finish the task in front of it, an AI may also widen the scope, copy a business rule, or take a shortcut that costs the whole system more.

The charter keeps those standing constraints in the repository. They evolve with the project and can be reviewed. What they contribute:

| Contribution | How Candela does it | What it is for |
|---|---|---|
| Protect the long-term architecture | Do not invade the community edition; extend analytics as a sidecar | Keep upgrades and the existing data path intact |
| Bound the implementation | Docs first, a phase, acceptance, and non-goals | Less invented scope |
| Make duties explicit | Hats, one question each, output tied to a directory | Design, scheduling, and implementation stop crossing each other |
| One authority per fact | Docs, code, and config each have a job | Fewer facts with two answers |
| Control debt | Structure ratchet and baselines only shrink | Iteration does not keep making the architecture worse |
| Keep delivery lessons | Check release contents, sync the runtime | The same release failure is less likely to repeat |
| Carry project knowledge | Design, handoff, retrospectives, and the index | Work continues across sessions |

These are qualitative effects of the rules. There is no controlled comparison and no full statistic, so this document does not claim hours saved, fewer incidents, or superiority over other methods.

## 3. Core mechanisms

### 3.1 Duty, question, and directory

Each hat has a clear duty, one primary question, and one place for the output. Wear one hat at a time, so implementation does not quietly expand the product, and scheduling does not redesign. Changing a duty follows the charter and needs a person's approval.

This does not mean one Agent per hat. A single Agent can switch duties in order. Several Agents still need separate authority, write boundaries, and a check of the result.

### 3.2 Layers of authority

| Layer | Question it answers | Boundary of authority |
|---|---|---|
| AGENTS.md | How an Agent works | Behavior rules and standing constraints |
| Product docs | What, why, and how to accept it | User goals, experience, and scope |
| Architecture docs | How the system and its contracts are organized | Architecture intent, boundaries, reasons for the interface |
| Code, models, config templates | What actually runs | Executable behavior, types, the persistence model, runtime fields |
| Project docs and README | Where things stand | Status, milestones, and risk |
| INDEX.md | Where to look | Navigation and structure metadata |
| Acceptance and runtime records | What actually happened | Traceable verification evidence |

A spec does not become a second authority for runtime fields, and callers do not invent their own entity-id rules. When a design contract and the implementation disagree, expose the difference and decide it. Do not silently edit the doc to match the code, and do not change the implementation while ignoring what is running.

The current rules already require those layers to stay in sync. A full loop for finding drift, deciding it, fixing it, and closing it is still unfinished.

### 3.3 Design first, and scope control

Before implementation, product and architecture documents already exist in the repo, with a stable phase, a goal and scope, acceptance criteria, and non-goals. Whether the existing documents are enough is a judgment about the task. Writing them on the spot does not count as having passed the gate.

A file existing does not mean the plan is right. The gate also has to check that the requirement is clear, that the plan respects the red lines, and that acceptance covers the real risk. How a small fix cites an existing phase, and when it must add design, still needs an explicit change-size scale.

### 3.4 Red lines and exceptions

Red lines protect data, compatibility, secrets, and the source of config truth. An exception can only use the existing emergency override, and it records the reason, the deadline for the missing docs, and where the retrospective will live. The AI does not loosen the rules so it can keep going.

The charter governs the project. It does not override tool permissions, higher constraints of the execution environment, or an authority decision a person has already made.

### 3.5 Ratchets control the direction of change

Existing debt may stay for a while. Growth is limited. The check compares the current value with the baseline. A split moves the real responsibility and its tests. Renaming, moving the path, or widening the baseline does not pass the check.

Size metrics are a risk signal. They do not replace checks of dependency direction, domain boundaries, lifecycle, and who owns state. Mechanically splitting files is not an architecture improvement.

### 3.6 Done means evidence

Verification has layers: local tests pass, the CI artifact is the one you intend, the code is deployed into the target directory, the process loaded the new code, the data path works, and the browser experience is right. No layer stands in for another.

A newer version number and a service restart do not, by themselves, prove this code is in effect. Check the artifact contents and the running state. Without an account, the login page and the artifact check are proxy evidence. Pages after login stay marked as still to be checked by a person.

### 3.7 Write the lesson back

An operational problem closes a loop: problem → cause → a change to a rule or a check → the next run is constrained → verify and recheck. The retrospective keeps the background. The charter keeps the principle and the criterion that must be followed. The concrete steps live in a procedure doc or a script.

## 4. The working loop

1. A person states the goal, and the authority and limits already granted.
2. The Agent confirms its duty and reads the relevant rules and project facts.
3. State scope, non-goals, risk, and acceptance. Check the product and architecture preconditions.
4. The AI implements inside that authority, reusing the authoritative models and contracts.
5. Run the checks that fit, compare the output, and record failures and what was not verified.
6. When shipping, check the artifact, what was deployed, and the real running effect.
7. A person reviews decisions that need a call. The completion note gives evidence and what remains.
8. Write important decisions, incidents, and reusable lessons back to the right place.

CDD itself does not require a pause for approval at every step. Where to pause, and how far autonomous execution goes, is set by the project rules and the user's grant. A long task should still save the current state, decisions already made, the next step, and any drift, so a new session does not have to infer them again.

## 5. CDD and Skills: governance and domain experience

### 5.1 They answer different questions

A Skill packages the knowledge, procedure, tool use, and quality experience of one domain into a reusable capability. It mainly answers "how do we do this kind of thing well." A UI Skill carries layout and interaction experience. A docs Skill carries typesetting and a render-check procedure. A deploy Skill carries release steps.

CDD organizes decisions and responsibility in the project. It mainly answers "who is responsible, under what conditions they may act, which boundary they must hold, which evidence counts as done, and how experience enters the rules." It cares whether the project stays consistent and can keep evolving when several domain capabilities work together.

This is a split of function for this method, not a hard limit on what a Skill may contain. A Skill may include safety rules, approval requirements, and quality gates. CDD may cite operating experience. The distinction is the duty being carried, not the file name or the packaging.

| Dimension | Skill: experience in a named domain | CDD: project governance |
|---|---|---|
| Main goal | Raise the quality of one kind of task | Hold the project's boundaries, responsibility, and consistency |
| Core question | How to do this kind of thing well | Who may do it, when, what the boundary is, how to accept it |
| Typical contents | Domain knowledge, steps, tools, templates, domain checks | Role split, who is authoritative, design gates, red lines, exception mechanism |
| Scope | One domain or task, used when needed | Standing constraints across domains, tasks, and sessions |
| How it is reused | Apply domain experience to other projects | Extract general governance principles, then fit them to a project's rules |
| What verification watches | Whether this domain's output meets a professional bar | Whether the output matches the project goal, the contract, and the delivery evidence |
| How experience evolves | Improve the domain practice and its tools | Turn incidents, decisions, and debt into standing constraints |
| Typical failure | The experience does not apply, a step is skipped, or the output is not good enough | Overreach, mixed duties, conflicting authorities, scope creep, or a false "done" |

### 5.2 How they work together

CDD states the duty and the project constraints. The Agent picks the Skills that fit the task, uses that domain experience to do the work, then checks the result against both the domain standard and the project's acceptance. A conflict that needs a decision follows the existing instruction authority, the user's grant, and the project rules.

Loading a Skill does not automatically widen authority, and it does not waive a project red line or a design precondition. An authority already granted should not be asked for again, with no new reason, just because a Skill was invoked. CDD does not gain the power to override a higher execution constraint.

Adding an analysis page, as an example:

- CDD names the phase, the product and architecture documents that must already exist, the change that is allowed, and the acceptance bar.
- A UI Skill supplies domain experience for information hierarchy, layout, interaction, and accessibility.
- Project rules constrain the API contract, multilingual resources, language in caches, and growth of structural debt.
- Acceptance checks the page experience, contract consistency, check output, and real browser evidence together.

Professional page-design experience does not, by itself, decide to rewrite the data model or expand the product. Governance rules do not replace professional judgment about layout, interaction, and accessibility.

### 5.3 When experience becomes a governance rule

Domain operating experience can first settle into a Skill or a dedicated procedure. When the same kind of mistake keeps affecting the whole project, or it touches data, permissions, compatibility, or a responsibility boundary, consider promoting it to a project rule, and pair it with an executable check when you can.

For example, "how to check what the web release actually contains" is operating experience. "A release is not done until there is evidence that this artifact is the one running" is a governance criterion. The check steps can be reused. The duty and the criterion are set by the project's rules.

**A Skill supplies the professional practice. CDD organizes the conditions for using it, the responsibility boundary, and the acceptance loop.** When CDD is published, show how the governance rules call domain capability. Do not dump every domain procedure into the charter.

## 6. Current state and limits

A spot check of this repository shows that several PRDs already use a phase, acceptance, and non-goals; the structure ratchet has a script and a baseline; the build script calls the internationalization consistency check and the hardcoded-text check; operations notes include the failure background behind a release criterion. That shows some mechanisms are in place. It is not a full-repo audit, and it does not prove every rule is enforced.

Gaps that stay explicit:

- The build script and GitLab config inspected for this document did not call the structure ratchet. A delivery self-check and a CI gate that actually fails the build are still different things.
- When Python is missing, the build script warns and skips the internationalization check. Resource unit tests only cover part of that. That is an execution gap against a rule that says "CI always blocks it."
- `scripts/` already carries important deploy implementation, while the hat table and the implementation scope still mainly list `apps/` and `puppet/`. Aligning those duties needs approval.
- Several deploy paths already exist. Release rules need to say more clearly which path applies to which target.
- The root rules contain a lot of environment commands and hard-won details, which costs reading time and can drift.
- Design-before-code does not yet grade changes by size, so a small fix can pay too much documentation cost.
- Current task state, drift, and contract drift do not yet have one record and one close-out contract.
- Reuse across projects is not demonstrated, and there is no comparison data for speed or incident rate.

These improvements are candidates. This document does not authorize implementing them.

## 7. Where it can evolve

| Direction | Purpose |
|---|---|
| Align duties with which deploy path applies | A task can select the right rule |
| Put stable hard gates on the checks that must run | Narrow the gap between the rule and what actually executes |
| Separate root principles, domain rules, and environment procedures | Lower the reading cost and the drift of maintenance |
| Grade changes by size | Design-before-code cost matches the risk |
| Standardize task handoff and drift records | Long tasks and new sessions can continue |
| Close the loop on contract drift | Say how a difference is found, decided, and closed |
| Publish cases of how rules evolved | Method contributions can be reviewed |
| Try it on other projects, and measure | Test reuse and the actual effect |

The method stays valuable only if the right rule can be selected, executed reliably, and checked with evidence. `AGENTS.md` is the entry. The whole engineering loop is CDD.
