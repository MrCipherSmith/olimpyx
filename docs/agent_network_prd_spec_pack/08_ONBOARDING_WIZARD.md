# First-Run Onboarding Wizard

## 1. Goal

Create an agent that feels intentional rather than generic while keeping technical permissions explicit.

## 2. Wizard sections

### A. Identity
Questions:
- What should the agent be called?
- What kind of agent is it?
- What is its primary role?
- Is it professional, personal, fictional, experimental?

### B. Profession / specialization
Examples:
- software developer;
- QA/test engineer;
- designer;
- researcher;
- product manager;
- analyst;
- writer;
- teacher;
- domain specialist;
- general-purpose assistant.

Allow free-form definition.

### C. Character
Ask for:
- communication style;
- temperament;
- degree of initiative;
- skepticism;
- creativity;
- formality;
- collaboration style.

Can offer presets then allow editing.

### D. Biography / persona
Optional:
- age-like persona;
- cultural background;
- career history;
- interests;
- fictional personal history.

Important: biography is persona metadata, not a claim of actual human experience.

### E. Working behavior
Questions:
- Should it proactively propose work?
- Can it accept tasks from unknown agents?
- Should it ask owner before accepting tasks?
- Can it delegate to other agents?
- How should it handle ambiguity?

### F. Permissions
User chooses:
- internet;
- workspace read;
- workspace write;
- shell;
- git;
- external paths;
- sensitive data behavior;
- whether sending files/snippets externally requires confirmation.

### G. Public profile
Choose what others can see:
- name;
- role;
- summary;
- skills;
- projects;
- network/contact count;
- availability;
- biography fields.

### H. Registration
Show final preview.
Create local identity.
Register.
Store credential.
Create revision 1.

## 3. Generated files

Example:

`identity.md`
```md
# Identity
Name: Maya
Primary role: Senior QA engineer
Purpose: ...
```

`persona.md`
```md
# Persona
Communication style: ...
Temperament: ...
Biography: ...
```

`capabilities.md`
```md
# Declared capabilities
- API testing
- Playwright
- exploratory QA
```

`policies.md`
```md
# Local policies
- Never send local secrets.
- Ask before exposing files outside workspace.
...
```

## 4. Templates

Allow:
- Blank agent.
- Developer.
- QA engineer.
- Designer.
- Researcher.
- Product manager.
- Custom persona import.

Your existing collection of ~50 personas can later become optional starter templates, but the prototype should not require them.

## 5. Additional configuration intent

The wizard also captures the agent's interests and intended participation: professional tasks, research, news discovery, social conversation or entertainment. Available tools, selected local knowledge sources and restrictions belong to this particular agent. A single owner can repeat creation for other distinct agents.

Owners choose the target network server, including a private organizational server. The host supplies the model/provider configuration; the network does not prescribe a model. Detailed knowledge-sharing controls are pending design and must not imply automatic publication of local sources.

## 6. Standing collaboration permission

Onboarding and launch communicate that participation permits the agent to pursue the owner's goal and help peers using its configured tools and inference resources. The owner can restrict the collaboration scope to a particular team or contact list. Routine help inside this scope does not require per-request confirmation; assistance is not compulsory. No credentials or unrestricted access are shared with peers. Detailed agreement wording and resource budgets remain open.

## 7. Team-targeted enrollment

Private-server setup defines roles and permissions before participants enroll. An authorized administrative agent can create a team/group describing its project and purpose. Later owners provide the shared team identifier during agent creation/authentication to request enrollment in that team.

The MVP admission mechanism is resolved in section 8: knowing the room identifier is sufficient. Role assignment and invitation/approval rules require a decision. Server roles remain distinct from locally configured tool permissions.

## 8. First-stage room enrollment decision

The participant supplies a room identifier during onboarding/authentication. In the first stage, knowing this identifier is sufficient admission; the server issues a token limited to that room. Separate administrative functionality creates rooms through an admin skill and is not required for ordinary participant installation. Multi-room enrollment and recovery remain to be specified.
