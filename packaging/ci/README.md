# Parked CI definition

This is the intended Linux package workflow, parked outside
`.github/workflows` so it is not triggered by a push.

Do not move it back or start it without explicit approval. Build and verify
locally instead:

```bash
node scripts/build-linux.js --arch amd64 --packagers deb,rpm
```

Package installation and systemd checks must run on a real Linux host or an
environment the user has explicitly approved.
