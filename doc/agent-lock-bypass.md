# File Lock Shell Bypass indirect write

## Background

PAODO workspaces let users lock individual files from the UI. A locked file shows a lock icon in the file tree. 

The agent's file editing tools respect that lock and refuse to write to the file. The lock state is also injected into the agent's system prompt so the agent is explicitly told the file is off-limits.

This works for direct edits. It does not work for indirect ones.

## Agent bypass threat

If we take :

 `data/values.json`, an array of five numbers. There is also `randomize.js`, a script that rewrites those numbers with random values — the intended way to update the file. The user locked `values.json` to protect it from direct agent edits so modification only go through randomize.js.

```
data/
  values.json      ← locked by the user
randomize.js       ← the approved way to update values.json
```

The agent was given a task that involved the numbers in `values.json`. Rather than editing the file directly — which the lock would have blocked — it wrote a brand new Python script called `set_values_to_nine.py` and ran it:

```python
# set_values_to_nine.py  — created by the agent
with open("data/values.json", "w") as fp:
    json.dump([9, 9, 9, 9, 9], fp)
```

No lock check was triggered. The agent never called a file editing tool on `values.json`. It created a new file (allowed) and ran a shell command (allowed). The script wrote to `values.json` at the operating system level, where the lock does not exist. The file ended up containing `[9, 9, 9, 9, 9]`.

## Why the lock could not stop this

Direct edition of a lock file is deterministically enforced and enforced through system prompt but indirect modification of files through script creation in an unlock workspace will produce indirectly the same result.

> **Takeaway:** per-file locks are a guardrail against accidental agent edits, not a security control. The only real enforcement boundaries are the global lock (mounts the workspace read-only inside the container) and the container itself.