# AssemblyAI STT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add AssemblyAI as the default cloud streaming STT provider so the speech pipeline no longer depends on Deepgram.

**Architecture:** Keep the existing Model Provider dispatch shape. Add an AssemblyAI credential to `Settings`, expose `assemblyai` as a cloud transcription provider, and build `AssemblyAISTTService` from `_build_cloud_transcription_service()`.

**Tech Stack:** Python 3.12, Pipecat `AssemblyAISTTService`, FastAPI backend, existing JSON `model_providers.json` runtime configuration.

## Global Constraints

- Keep WebRTC and the existing pipeline shape unchanged.
- Use AssemblyAI streaming STT, not batch transcription.
- Preserve Deepgram and OpenRouter as selectable fallback providers.
- Do not commit real API keys.

---

### Task 1: Add AssemblyAI Provider Wiring

**Files:**
- Modify: `app/config.py`
- Modify: `app/model_providers.py`
- Modify: `app/pipeline.py`
- Modify: `.env.example`
- Test: `tests/test_assemblyai_provider.py`

**Interfaces:**
- Consumes: `Settings`, `CloudProviderConfig`, `ModelProviders`
- Produces: `settings.assemblyai_api_key`, `ASSEMBLYAI_DEFAULT_MODEL`, `assemblyai` provider dispatch

- [ ] **Step 1: Write failing tests**
- [ ] **Step 2: Run tests and confirm failure**
- [ ] **Step 3: Add minimal AssemblyAI wiring**
- [ ] **Step 4: Run tests and confirm pass**
- [ ] **Step 5: Update local `.env` and `model_providers.json`**
- [ ] **Step 6: Restart backend and verify `/api/status`**
