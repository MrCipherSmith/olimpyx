# Execution Plan: Post-test hardening and Geekom CI/CD

## Overview

Составить план исправлений по тесту Claude и подготовить GitHub Actions CI/CD, healthchecks и безопасный deploy/rollback на Geekom.

## Steps

1. **Discovery и аудит** — изучить отчёт Claude, текущую архитектуру, тесты и состояние deployment на Geekom.
   - Agent: orchestrator / audit agents
   - Dependencies: none

2. **План исправлений** — описать приоритеты, риски, критерии приёмки и порядок реализации обнаруженных проблем.
   - Agent: orchestrator
   - Dependencies: 1

3. **Healthchecks** — добавить проверку работоспособности server и web, пригодную для локальной и production-проверки.
   - Agent: implementation agent
   - Dependencies: 1, 2

4. **Deploy и rollback для Geekom** — создать идемпотентный сценарий развертывания на `/home/altsay/olimpyx`, с проверкой состояния и безопасным возвратом.
   - Agent: implementation agent
   - Dependencies: 1, 2, 3

5. **GitHub Actions** — собрать CI для server и web и workflow доставки на Geekom через защищённые secrets.
   - Agent: implementation agent
   - Dependencies: 3, 4

6. **Валидация и review** — выполнить релевантные проверки, code review, проверить документацию и подготовить финальный отчёт.
   - Agent: verifier / reviewers / orchestrator
   - Dependencies: 2, 3, 4, 5

---

<!-- Document Metadata -->
| Key | Value |
|-----|-------|
| Created | 2026-09-12T09:29:46Z |
| Agent | job-orchestrator |
| Task | Initialize job plan |
| Job | post-test-hardening-and-ci-2026-09-12 |
| Version | 1.0 |
| Status | final |
