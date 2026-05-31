# How PAODO WS Works

A visual explanation for non-technical readers.

---

## The Big Picture

```
  You (or anyone you give access to)
              |
              | opens a browser
              |
              v
  +------------------------------------------+
  |            PAODO WS  (your server)       |
  |                                          |
  |   Manages workspaces, routes messages,   |
  |   streams live output to your screen     |
  +------------------------------------------+
              |
              | spins up isolated boxes
              |
    +---------+---------+---------+
    |                   |         |
    v                   v         v
+----------+     +----------+     +----------+
|          |     |          |     |          |
| Bakery   |     | Supplier |     | Accounts |
| Workspace|     | Workspace|     | Workspace|
|          |     |          |     |          |
+----------+     +----------+     +----------+

  Each box is completely separate from the others.
  What happens in one cannot affect another.
```

---

## What Is Inside a Workspace

```
+-----------------------------------------------+
|                  ONE WORKSPACE                |
|                                               |
|   +----------+    Reads and writes            |
|   |          |    Runs commands               |
|   |  AI Agent| -- Browses the web             |
|   |          |    Calls other agents          |
|   +----------+                                |
|        |                                      |
|        | works on                             |
|        v                                      |
|   +----------+    Your files live here        |
|   |  Files   |    Scripts, data, reports,     |
|   |  & Code  |    config — all yours          |
|   +----------+                                |
|        |                                      |
|        | runs inside                          |
|        v                                      |
|   +----------+    An isolated terminal        |
|   | Sandbox  |    The agent can install       |
|   | (Docker) |    languages and packages      |
|   +----------+    freely — nothing leaks out  |
|                                               |
+-----------------------------------------------+

  The agent can read, write, and run anything inside
  its workspace. It cannot touch any other workspace.
```

---

## How Workspaces Talk to Each Other

Workspaces can be wired together so one agent can ask another for help.
You decide who can call who — the connections only go in the directions you draw.

```
                  +---------------+
                  |  Coordinator  |
                  |   Workspace   |
                  +-------+-------+
                          |
           "get me the    |    "what is today's
            stock level"  |     weather forecast?"
                          |
           +--------------+--------------+
           |                             |
           v                             v
  +--------+--------+          +---------+-------+
  |    Inventory    |          |    Weather      |
  |    Workspace    |          |    Workspace    |
  +-----------------+          +-----------------+

  Each arrow is a permission you explicitly grant.
  Inventory cannot call Weather unless you draw that arrow.
  This keeps workflows predictable and auditable.
```

---

## Triggering a Workspace from Outside

Every workspace has its own private URL. Any external tool — a chatbot,
a scheduled script, a form submission — can send it a message and get a response.

```
  Customer chatbot          Scheduled job         Your own script
        |                        |                      |
        | "check order #482"     | "run daily report"   | "process CSV"
        |                        |                      |
        +------------------------+----------------------+
                                 |
                                 | HTTP request + API key
                                 |
                                 v
                      +----------+----------+
                      |   Target Workspace  |
                      |                     |
                      |   Agent reads the   |
                      |   request, does the |
                      |   work, replies     |
                      +---------------------+

  The workspace acts like a small service.
  The agent is the logic. The files are the memory.
```

---

## Lifecycle of a Workspace

A workspace only consumes resources when someone is actually using it.

```
  Tab closed /        Tab opened /
  no one connected    someone connects
         |                  |
         v                  v
   +-----------+       +----------+
   |  SLEEPING |  -->  |  AWAKE   |
   |           |       |          |
   | No memory | (~400ms warm-up) |
   | No network|      | Ready     |
   | No cost   |      | to work   |
   +-----------+      +-----------+

  1000 sleeping workspaces = 0 wasted resources.
  A workspace wakes up in under a second when needed.
  All files are safe while it sleeps — nothing is lost.
```

---

## Summary

```
  +----------------------------------------------------------+
  |                                                          |
  |   You describe what you want  -->  Agent does the work   |
  |                                                          |
  |   Files = the memory            Agent = the logic        |
  |                                                          |
  |   Each workspace is isolated    Agents can collaborate   |
  |   (nothing leaks out)           (if you allow it)        |
  |                                                          |
  |   Any tool can trigger          Sleeps when idle         |
  |   a workspace via API           (costs nothing)          |
  |                                                          |
  +----------------------------------------------------------+
```
