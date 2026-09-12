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
