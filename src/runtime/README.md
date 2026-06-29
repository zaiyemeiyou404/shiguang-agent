# Runtime

Owns bounded execution of runs:

- run start and completion handling
- event streaming
- tool-call mediation
- cancellation and timeout handling
- normalized errors

The runtime records what happened; the core decides what should happen next.

