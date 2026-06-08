# Settings Restart Rebuild Design

## Goal

Add a `Restart + Rebuild` action in Settings that lets the user confirm and trigger `./start.sh --restart --rebuild`, then observe task state from the UI without leaving the app.

## Scope

This change covers:
- A new restart action in the Settings UI
- A confirmation dialog before execution
- A backend endpoint that starts a fixed restart task
- A backend endpoint that reports current task status and recent output
- Frontend polling and status display

This change does not cover:
- Streaming full process logs
- Arbitrary shell execution from the UI
- Multi-task history beyond the latest restart task

## UX

The action lives in the Settings `About` tab near existing version/build information.

The UI adds:
- A `Restart + Rebuild` button
- A confirmation dialog before execution
- A compact status block showing:
  - `Idle`
  - `Running`
  - `Success`
  - `Failed`
- A short recent-output area showing the latest log summary while running and after completion

Behavior:
- Clicking the button opens a confirm dialog
- Confirm text states that TmuxGo services (`frontend`, `gateway`, `agent`) will restart and rebuild
- Confirm text also states that the action does not intentionally kill existing tmux sessions
- While a task is running, the button is disabled
- When the task finishes, the UI keeps the final status and recent output visible until the settings panel closes or a later task replaces it

## Backend Design

Add a small in-memory restart task manager inside the gateway process.

Task model:
- `status`: `idle | running | success | error`
- `startedAt`
- `finishedAt`
- `summaryLines`: recent stdout/stderr lines, capped to a small number such as 20
- `exitCode`
- `errorMessage`

Execution rules:
- The backend exposes a fixed action only: run `./start.sh --restart --rebuild`
- The command runs with `cwd` set to the repository root
- The backend rejects new start requests while one restart task is already running
- The backend captures stdout and stderr together into recent summary lines
- On exit code `0`, mark `success`
- On non-zero exit or spawn failure, mark `error`

Endpoints:
- `POST /api/system/restart-rebuild`
  - starts a task if none is running
  - returns current task state
- `GET /api/system/restart-rebuild`
  - returns current task state

Security boundary:
- No command string is accepted from the client
- The backend executes only the fixed repository-local restart command

## Frontend Design

Add a small restart control to `Settings.tsx` in the `about` tab.

Frontend state:
- local confirm dialog visibility
- task status fetched from backend
- polling active while status is `running`

Interaction flow:
1. User opens Settings -> About
2. User clicks `Restart + Rebuild`
3. Confirm dialog appears
4. User confirms
5. Frontend calls `POST /api/system/restart-rebuild`
6. UI switches to `running`
7. Frontend polls `GET /api/system/restart-rebuild`
8. UI updates summary and final state
9. Toast reports success or failure at terminal state

Polling:
- Poll only while Settings is open and task state is `running`
- Poll interval should be moderate, such as 1 second
- Stop polling once task reaches `success` or `error`

## Error Handling

Cases to handle:
- Backend unavailable: show failure status and error toast
- Duplicate trigger during running: keep running state, no second task
- Process spawn failure: show `error`
- Non-zero exit: show `error` and latest summary lines
- Missing `start.sh`: report backend error cleanly

## Testing

Frontend:
- Add a failing test first for the settings restart control
- Verify confirm dialog appears
- Verify confirm action triggers backend mutation
- Verify button disables during running
- Verify status text and summary render from task state

Backend:
- Add a failing test first for the new restart endpoints
- Verify `POST` starts the fixed task
- Verify concurrent `POST` while running does not start a second task
- Verify `GET` returns latest task state
- Verify recent output is capped

## Implementation Notes

Prefer reusing existing API hook patterns in the frontend and existing route registration style in the gateway.

Keep the restart manager single-purpose and local to system routes or a nearby helper, rather than introducing a generalized job framework.
